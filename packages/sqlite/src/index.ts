import { deepEqual, Dict, difference, isNullable, makeArray } from 'cosmokit'
import { Database, Driver, Eval, executeUpdate, Field, Model, randomId, Selection } from '@minatojs/core'
import { Builder, escapeId } from '@minatojs/sql-utils'
import { promises as fs } from 'fs'
import init from '@minatojs/sql.js'
import Logger from 'reggol'

const logger = new Logger('sqlite')

function getTypeDef({ type }: Field) {
  switch (type) {
    case 'primary':
    case 'boolean':
    case 'integer':
    case 'unsigned':
    case 'date':
    case 'time':
    case 'timestamp': return `INTEGER`
    case 'float':
    case 'double':
    case 'decimal': return `REAL`
    case 'char':
    case 'string':
    case 'text':
    case 'list':
    case 'json': return `TEXT`
  }
}

export interface SQLiteFieldInfo {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string
  pk: boolean
}

export namespace SQLiteDriver {
  export interface Config {
    path: string
  }
}

class SQLiteBuilder extends Builder {
  protected escapeMap = {
    "'": "''",
  }

  constructor(tables?: Dict<Model>) {
    super(tables)

    this.evalOperators.$if = (args) => `iif(${args.map(arg => this.parseEval(arg)).join(', ')})`
    this.evalOperators.$concat = (args) => `(${args.map(arg => this.parseEval(arg)).join('||')})`
    this.evalOperators.$length = (expr) => this.createAggr(expr, value => `count(${value})`, value => {
      if (this.state.sqlType === 'json') {
        this.state.sqlType = 'raw'
        return `${this.jsonLength(value)}`
      } else {
        this.state.sqlType = 'raw'
        return `iif(${value}, LENGTH(${value}) - LENGTH(REPLACE(${value}, ${this.escape(',')}, ${this.escape('')})) + 1, 0)`
      }
    })

    this.define<boolean, number>({
      types: ['boolean'],
      dump: value => +value,
      load: (value) => !!value,
    })

    this.define<object, string>({
      types: ['json'],
      dump: value => JSON.stringify(value),
      load: (value, initial) => value ? JSON.parse(value) : initial,
    })

    this.define<string[], string>({
      types: ['list'],
      dump: value => Array.isArray(value) ? value.join(',') : value,
      load: (value) => value ? value.split(',') : [],
    })

    this.define<Date, number>({
      types: ['date', 'time', 'timestamp'],
      dump: value => value === null ? null : +new Date(value),
      load: (value) => value === null ? null : new Date(value),
    })
  }

  escape(value: any, field?: Field<any>) {
    if (value instanceof Date) value = +value
    return super.escape(value, field)
  }

  protected createElementQuery(key: string, value: any) {
    if (this.state.sqlTypes?.[this.unescapeId(key)] === 'json') {
      return this.jsonContains(key, this.quote(JSON.stringify(value)))
    } else {
      return `(',' || ${key} || ',') LIKE ${this.escape('%,' + value + ',%')}`
    }
  }

  protected jsonLength(value: string) {
    return `json_array_length(${value})`
  }

  protected jsonContains(obj: string, value: string) {
    return `json_array_contains(${obj}, ${value})`
  }

  protected jsonUnquote(value: string, pure: boolean = false) {
    return value
  }

  protected createAggr(expr: any, aggr: (value: string) => string, nonaggr?: (value: string) => string) {
    if (!this.state.group && !nonaggr) {
      const value = this.parseEval(expr, false)
      return `(select ${aggr(escapeId('value'))} from json_each(${value}) ${randomId()})`
    } else {
      return super.createAggr(expr, aggr, nonaggr)
    }
  }

  protected groupArray(value: string) {
    const res = this.state.sqlType === 'json' ? `('[' || group_concat(${value}) || ']')` : `('[' || group_concat(json_quote(${value})) || ']')`
    this.state.sqlType = 'json'
    return `ifnull(${res}, json_array())`
  }

  protected transformJsonField(obj: string, path: string) {
    this.state.sqlType = 'raw'
    return `json_extract(${obj}, '$${path}')`
  }
}

export class SQLiteDriver extends Driver {
  db!: init.Database
  sql: Builder
  writeTask?: NodeJS.Timeout
  sqlite!: init.SqlJsStatic

  constructor(database: Database, public config: SQLiteDriver.Config) {
    super(database)

    this.sql = new SQLiteBuilder()
  }

  /** synchronize table schema */
  async prepare(table: string, dropKeys?: string[]) {
    const columns = this.#all(`PRAGMA table_info(${escapeId(table)})`) as SQLiteFieldInfo[]
    const model = this.model(table)
    const columnDefs: string[] = []
    const indexDefs: string[] = []
    const alter: string[] = []
    const mapping: Dict<string> = {}
    let shouldMigrate = false

    // field definitions
    for (const key in model.fields) {
      if (model.fields[key]!.deprecated) {
        if (dropKeys?.includes(key)) shouldMigrate = true
        continue
      }

      const legacy = [key, ...model.fields[key]!.legacy || []]
      const column = columns.find(({ name }) => legacy.includes(name))
      const { initial, nullable = true } = model.fields[key]!
      const typedef = getTypeDef(model.fields[key]!)
      let def = `${escapeId(key)} ${typedef}`
      if (key === model.primary && model.autoInc) {
        def += ' NOT NULL PRIMARY KEY AUTOINCREMENT'
      } else {
        def += (nullable ? ' ' : ' NOT ') + 'NULL'
        if (!isNullable(initial)) {
          def += ' DEFAULT ' + this.sql.escape(this.sql.dump(model, { [key]: initial })[key])
        }
      }
      columnDefs.push(def)
      if (!column) {
        alter.push('ADD ' + def)
      } else {
        mapping[column.name] = key
        shouldMigrate ||= column.name !== key || column.type !== typedef
      }
    }

    // index definitions
    if (model.primary && !model.autoInc) {
      indexDefs.push(`PRIMARY KEY (${this.#joinKeys(makeArray(model.primary))})`)
    }
    if (model.unique) {
      indexDefs.push(...model.unique.map(keys => `UNIQUE (${this.#joinKeys(makeArray(keys))})`))
    }
    if (model.foreign) {
      indexDefs.push(...Object.entries(model.foreign).map(([key, value]) => {
        const [table, key2] = value!
        return `FOREIGN KEY (\`${key}\`) REFERENCES ${escapeId(table)} (\`${key2}\`)`
      }))
    }

    if (!columns.length) {
      logger.info('auto creating table %c', table)
      this.#run(`CREATE TABLE ${escapeId(table)} (${[...columnDefs, ...indexDefs].join(', ')})`)
    } else if (shouldMigrate) {
      // preserve old columns
      for (const { name, type, notnull, pk, dflt_value: value } of columns) {
        if (mapping[name] || dropKeys?.includes(name)) continue
        let def = `${escapeId(name)} ${type}`
        def += (notnull ? ' NOT ' : ' ') + 'NULL'
        if (pk) def += ' PRIMARY KEY'
        if (value !== null) def += ' DEFAULT ' + this.sql.escape(value)
        columnDefs.push(def)
        mapping[name] = name
      }

      const temp = table + '_temp'
      const fields = Object.keys(mapping).map(escapeId).join(', ')
      logger.info('auto migrating table %c', table)
      this.#run(`CREATE TABLE ${escapeId(temp)} (${[...columnDefs, ...indexDefs].join(', ')})`)
      try {
        this.#run(`INSERT INTO ${escapeId(temp)} SELECT ${fields} FROM ${escapeId(table)}`)
        this.#run(`DROP TABLE ${escapeId(table)}`)
      } catch (error) {
        this.#run(`DROP TABLE ${escapeId(temp)}`)
        throw error
      }
      this.#run(`ALTER TABLE ${escapeId(temp)} RENAME TO ${escapeId(table)}`)
    } else if (alter.length) {
      logger.info('auto updating table %c', table)
      for (const def of alter) {
        this.#run(`ALTER TABLE ${escapeId(table)} ${def}`)
      }
    }

    if (dropKeys) return
    dropKeys = []
    this.migrate(table, {
      error: logger.warn,
      before: keys => keys.every(key => columns.some(({ name }) => name === key)),
      after: keys => dropKeys!.push(...keys),
      finalize: () => {
        if (!dropKeys!.length) return
        this.prepare(table, dropKeys)
      },
    })
  }

  init(buffer: ArrayLike<number> | null) {
    this.db = new this.sqlite.Database(buffer)
    this.db.create_function('regexp', (pattern, str) => +new RegExp(pattern).test(str))
    this.db.create_function('json_array_contains', (array, value) => +(JSON.parse(array) as any[]).includes(JSON.parse(value)))
  }

  async load() {
    if (this.config.path === ':memory:') return null
    return fs.readFile(this.config.path).catch(() => null)
  }

  async start() {
    const [sqlite, buffer] = await Promise.all([
      init({
        locateFile: (file: string) => process.env.KOISHI_BASE
          ? process.env.KOISHI_BASE + '/' + file
          : process.env.KOISHI_ENV === 'browser'
            ? '/modules/@koishijs/plugin-database-sqlite/' + file
            : require.resolve('@minatojs/sql.js/dist/' + file),
      }),
      this.load(),
    ])
    this.sqlite = sqlite
    this.init(buffer)
  }

  #joinKeys(keys?: string[]) {
    return keys?.length ? keys.map(key => `\`${key}\``).join(', ') : '*'
  }

  async stop() {
    await new Promise(resolve => setTimeout(resolve, 0))
    this.db?.close()
  }

  #exec(sql: string, params: any, callback: (stmt: init.Statement) => any) {
    try {
      const stmt = this.db.prepare(sql)
      const result = callback(stmt)
      stmt.free()
      logger.debug('> %s', sql)
      return result
    } catch (e) {
      logger.warn('> %s', sql)
      throw e
    }
  }

  #all(sql: string, params: any = []) {
    return this.#exec(sql, params, (stmt) => {
      stmt.bind(params)
      const result: any[] = []
      while (stmt.step()) {
        result.push(stmt.getAsObject())
      }
      return result
    })
  }

  #get(sql: string, params: any = []) {
    return this.#exec(sql, params, stmt => stmt.getAsObject(params))
  }

  #export() {
    const data = this.db.export()
    fs.writeFile(this.config.path, data)
    this.init(data)
  }

  #run(sql: string, params: any = [], callback?: () => any) {
    this.#exec(sql, params, stmt => stmt.run(params))
    const result = callback?.()
    if (this.config.path) {
      clearTimeout(this.writeTask)
      this.writeTask = setTimeout(() => this.#export(), 0)
    }
    return result
  }

  async drop(table?: string) {
    if (table) return this.#run(`DROP TABLE ${escapeId(table)}`)
    const tables = Object.keys(this.database.tables)
    for (const table of tables) {
      this.#run(`DROP TABLE ${escapeId(table)}`)
    }
  }

  async stats() {
    const data = this.db.export()
    this.init(data)
    const stats: Driver.Stats = { size: data.byteLength, tables: {} }
    const tableNames: { name: string }[] = this.#all('SELECT name FROM sqlite_master WHERE type="table" ORDER BY name;')
    const dbstats: { name: string; size: number }[] = this.#all('SELECT name, pgsize as size FROM "dbstat" WHERE aggregate=TRUE;')
    tableNames.forEach(tbl => {
      stats.tables[tbl.name] = this.#get(`SELECT COUNT(*) as count FROM ${escapeId(tbl.name)};`)
      stats.tables[tbl.name].size = dbstats.find(o => o.name === tbl.name)!.size
    })
    return stats
  }

  async remove(sel: Selection.Mutable) {
    const { query, table } = sel
    const filter = this.sql.parseQuery(query)
    if (filter === '0') return
    this.#run(`DELETE FROM ${escapeId(table)} WHERE ${filter}`)
  }

  async get(sel: Selection.Immutable) {
    const { model, tables } = sel
    const builder = new SQLiteBuilder(tables)
    const sql = builder.get(sel)
    if (!sql) return []
    const rows = this.#all(sql)
    return rows.map(row => builder.load(model, row))
  }

  async eval(sel: Selection.Immutable, expr: Eval.Expr) {
    const builder = new SQLiteBuilder(sel.tables)
    const inner = builder.get(sel.table as Selection, true, true)
    const output = builder.parseEval(expr, false)
    const { value } = this.#get(`SELECT ${output} AS value FROM ${inner}`)
    return builder.load(value)
  }

  #update(sel: Selection.Mutable, indexFields: string[], updateFields: string[], update: {}, data: {}) {
    const { ref, table } = sel
    const model = this.model(table)
    const row = this.sql.dump(model, executeUpdate(data, update, ref))
    const assignment = updateFields.map((key) => `${escapeId(key)} = ${this.sql.escape(row[key])}`).join(',')
    const query = Object.fromEntries(indexFields.map(key => [key, row[key]]))
    const filter = this.sql.parseQuery(query)
    this.#run(`UPDATE ${escapeId(table)} SET ${assignment} WHERE ${filter}`)
  }

  async set(sel: Selection.Mutable, update: {}) {
    const { model, table, query } = sel
    const { primary, fields } = model
    const updateFields = [...new Set(Object.keys(update).map((key) => {
      return Object.keys(fields).find(field => field === key || key.startsWith(field + '.'))!
    }))]
    const primaryFields = makeArray(primary)
    const data = await this.database.get(table, query)
    for (const row of data) {
      this.#update(sel, primaryFields, updateFields, update, row)
    }
  }

  #create(table: string, data: {}) {
    const model = this.model(table)
    data = this.sql.dump(model, data)
    const keys = Object.keys(data)
    const sql = `INSERT INTO ${escapeId(table)} (${this.#joinKeys(keys)}) VALUES (${keys.map(key => this.sql.escape(data[key])).join(', ')})`
    return this.#run(sql, [], () => this.#get(`SELECT last_insert_rowid() AS id`))
  }

  async create(sel: Selection.Mutable, data: {}) {
    const { model, table } = sel
    data = model.create(data)
    const { id } = this.#create(table, data)
    const { autoInc, primary } = model
    if (!autoInc || Array.isArray(primary)) return data as any
    return { ...data, [primary]: id }
  }

  async upsert(sel: Selection.Mutable, data: any[], keys: string[]) {
    if (!data.length) return
    const { model, table, ref } = sel
    const dataFields = [...new Set(Object.keys(Object.assign({}, ...data)).map((key) => {
      return Object.keys(model.fields).find(field => field === key || key.startsWith(field + '.'))!
    }))]
    let updateFields = difference(dataFields, keys)
    if (!updateFields.length) updateFields = [dataFields[0]]
    // Error: Expression tree is too large (maximum depth 1000)
    const step = Math.floor(960 / keys.length)
    for (let i = 0; i < data.length; i += step) {
      const chunk = data.slice(i, i + step)
      const results = await this.database.get(table, {
        $or: chunk.map(item => Object.fromEntries(keys.map(key => [key, item[key]]))),
      })
      for (const item of chunk) {
        const row = results.find(row => keys.every(key => deepEqual(row[key], item[key], true)))
        if (row) {
          this.#update(sel, keys, updateFields, item, row)
        } else {
          this.#create(table, executeUpdate(model.create(), item, ref))
        }
      }
    }
  }
}

export default SQLiteDriver
