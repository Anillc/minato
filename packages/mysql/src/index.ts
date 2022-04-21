import { createPool, escapeId, format, escape as mysqlEscape } from '@vlasky/mysql'
import type { OkPacket, Pool, PoolConfig } from 'mysql'
import { Dict, difference, makeArray, pick, Time } from 'cosmokit'
import { Database, Driver, Eval, Executable, executeUpdate, Field, isEvalExpr, Model, Modifier, RuntimeError } from 'cosmotype'
import { Builder } from '@cosmotype/sql-utils'
import Logger from 'reggol'

declare module 'mysql' {
  interface UntypedFieldInfo {
    packet: UntypedFieldInfo
  }
}

const logger = new Logger('mysql')

const DEFAULT_DATE = new Date('1970-01-01')

function getIntegerType(length = 11) {
  if (length <= 4) return 'tinyint'
  if (length <= 6) return 'smallint'
  if (length <= 9) return 'mediumint'
  if (length <= 11) return 'int'
  return 'bigint'
}

function getTypeDefinition({ type, length, precision, scale }: Field) {
  switch (type) {
    case 'float':
    case 'double':
    case 'date':
    case 'time': return type
    case 'timestamp': return 'datetime'
    case 'integer': return getIntegerType(length)
    case 'unsigned': return `${getIntegerType(length)} unsigned`
    case 'decimal': return `decimal(${precision}, ${scale}) unsigned`
    case 'char': return `char(${length || 255})`
    case 'string': return `varchar(${length || 255})`
    case 'text': return `text(${length || 65535})`
    case 'list': return `text(${length || 65535})`
    case 'json': return `text(${length || 65535})`
  }
}

function backtick(str: string) {
  return '`' + str + '`'
}

function createIndex(keys: string | string[]) {
  return makeArray(keys).map(backtick).join(', ')
}

class MySQLBuilder extends Builder {
  constructor(private models: Dict<Model>) {
    super()
  }

  format(sql: string, values: any[], stringifyObjects?: boolean, timeZone?: string) {
    return format(sql, values, stringifyObjects, timeZone)
  }

  escapeId(value: string, forbidQualified?: boolean) {
    return escapeId(value, forbidQualified)
  }

  escape(value: any, table?: string, field?: string) {
    return mysqlEscape(this.stringify(value, table, field))
  }

  stringify(value: any, table?: string, field?: string) {
    const meta = this.models[table]?.fields[field]
    if (meta?.type === 'json') {
      return JSON.stringify(value)
    } else if (meta?.type === 'list') {
      return value.join(',')
    } else if (Field.date.includes(meta?.type)) {
      return Time.template('yyyy-MM-dd hh:mm:ss', value)
    }

    return value
  }
}

interface ColumnInfo {
  COLUMN_NAME: string
  IS_NULLABLE: 'YES' | 'NO'
  DATA_TYPE: string
}

interface QueryTask {
  sql: string
  resolve: (value: any) => void
  reject: (error: Error) => void
}

namespace MySQLDriver {
  export interface Config extends PoolConfig {}
}

class MySQLDriver extends Driver {
  public pool: Pool
  public config: MySQLDriver.Config

  sql: MySQLBuilder

  private _queryTasks: QueryTask[] = []

  constructor(database: Database, config?: MySQLDriver.Config) {
    super(database, 'mysql')

    this.config = {
      host: 'localhost',
      port: 3306,
      charset: 'utf8mb4_general_ci',
      multipleStatements: true,
      typeCast: (field, next) => {
        const { orgName, orgTable } = field.packet
        const meta = this.database.tables[orgTable]?.fields[orgName]

        if (Field.string.includes(meta?.type)) {
          return field.string()
        } else if (meta?.type === 'json') {
          const source = field.string()
          return source ? JSON.parse(source) : meta.initial
        } else if (meta?.type === 'list') {
          const source = field.string()
          return source ? source.split(',') : []
        } else if (meta?.type === 'time') {
          const source = field.string()
          if (!source) return meta.initial
          const time = new Date(DEFAULT_DATE)
          const [h, m, s] = source.split(':')
          time.setHours(parseInt(h))
          time.setMinutes(parseInt(m))
          time.setSeconds(parseInt(s))
          return time
        }

        if (field.type === 'BIT') {
          return Boolean(field.buffer()?.readUInt8(0))
        } else {
          return next()
        }
      },
      ...config,
    }

    this.sql = new MySQLBuilder(database.tables)
  }

  async start() {
    this.pool = createPool(this.config)
    super.start()
  }

  async stop() {
    super.stop()
    this.pool.end()
  }

  private _getColDefs(name: string, columns: ColumnInfo[]) {
    const table = this.model(name)
    const { primary, foreign, autoInc } = table
    const fields = { ...table.fields }
    const unique = [...table.unique]
    const create: string[] = []
    const update: string[] = []

    // orm definitions
    for (const key in fields) {
      let shouldUpdate = false
      const legacy = columns.find(info => info.COLUMN_NAME === key)
      const { initial, nullable = true } = fields[key]

      let def = backtick(key)
      if (key === primary && autoInc) {
        def += ' int unsigned not null auto_increment'
      } else {
        const typedef = getTypeDefinition(fields[key])
        // const typename = typedef.split(/[ (]/)[0]
        // if (legacy && legacy.DATA_TYPE !== typename) {
        //   logger.warn(`${name}.${key} data type mismatch: ${legacy.DATA_TYPE} => ${typedef}`)
        //   shouldUpdate = true
        // }
        def += ' ' + typedef
        if (makeArray(primary).includes(key)) {
          def += ' not null'
        } else {
          def += (nullable ? ' ' : ' not ') + 'null'
        }
        // blob, text, geometry or json columns cannot have default values
        if (initial && !typedef.startsWith('text')) {
          def += ' default ' + this.sql.escape(initial, name, key)
        }
      }

      if (!legacy) {
        create.push(def)
      } else if (shouldUpdate) {
        update.push(def)
      }
    }

    if (!columns.length) {
      create.push(`primary key (${createIndex(primary)})`)
      for (const key of unique) {
        create.push(`unique index (${createIndex(key)})`)
      }
      for (const key in foreign) {
        const [table, key2] = foreign[key]
        create.push(`foreign key (${backtick(key)}) references ${escapeId(table)} (${backtick(key2)})`)
      }
    }

    return [create, update]
  }

  /** synchronize table schema */
  async prepare(name: string) {
    const columns = await this.queue<ColumnInfo[]>(`
      SELECT COLUMN_NAME, IS_NULLABLE, DATA_TYPE
      FROM information_schema.columns
      WHERE TABLE_SCHEMA = ? && TABLE_NAME = ?
    `, [this.config.database, name])

    const [create, update] = this._getColDefs(name, columns)
    if (!columns.length) {
      logger.info('auto creating table %c', name)
      return this.queue(`CREATE TABLE ?? (${create.join(',')}) COLLATE = ?`, [name, this.config.charset])
    }

    const operations = [
      ...create.map(def => 'ADD ' + def),
      ...update.map(def => 'MODIFY ' + def),
    ]
    if (operations.length) {
      logger.info('auto updating table %c', name)
      await this.queue(`ALTER TABLE ?? ${operations.join(',')}`, [name])
    }
  }

  _inferFields(table: string, keys: readonly string[]) {
    if (!keys) return
    return keys
  }

  _joinKeys = (keys: readonly string[]) => {
    return keys ? keys.map(key => key.includes('`') ? key : `\`${key}\``).join(',') : '*'
  }

  _formatValues = (table: string, data: object, keys: readonly string[]) => {
    return keys.map((key) => this.sql.stringify(data[key], table as never, key))
  }

  query<T = any>(sql: string, values?: any): Promise<T> {
    const error = new Error()
    return new Promise((resolve, reject) => {
      sql = format(sql, values)
      logger.debug(sql)
      this.pool.query(sql, (err: Error, results) => {
        if (!err) return resolve(results)
        logger.warn(sql)
        if (err['code'] === 'ER_DUP_ENTRY') {
          err = new RuntimeError('duplicate-entry', err.message)
        }
        err.stack = err.message + error.stack.slice(5)
        reject(err)
      })
    })
  }

  queue<T = any>(sql: string, values?: any): Promise<T> {
    if (!this.config.multipleStatements) {
      return this.query(sql, values)
    }

    sql = format(sql, values)
    return new Promise<any>((resolve, reject) => {
      this._queryTasks.push({ sql, resolve, reject })
      process.nextTick(() => this._flushTasks())
    })
  }

  private async _flushTasks() {
    const tasks = this._queryTasks
    if (!tasks.length) return
    this._queryTasks = []

    try {
      let results = await this.query(tasks.map(task => task.sql).join('; '))
      if (tasks.length === 1) results = [results]
      tasks.forEach((task, index) => {
        task.resolve(results[index])
      })
    } catch (error) {
      tasks.forEach(task => task.reject(error))
    }
  }

  _select<T extends {}>(table: string, fields: readonly (string & keyof T)[], conditional?: string, values?: readonly any[]): Promise<T[]>
  _select(table: string, fields: string[], conditional?: string, values: readonly any[] = []) {
    logger.debug(`[select] ${table}: ${fields ? fields.join(', ') : '*'}`)
    const sql = 'SELECT '
      + this._joinKeys(fields)
      + (table.includes('.') ? `FROM ${table}` : ' FROM `' + table + '`')
      + (conditional ? ' WHERE ' + conditional : '')
    return this.queue(sql, values)
  }

  async drop() {
    const data = await this._select('information_schema.tables', ['TABLE_NAME'], 'TABLE_SCHEMA = ?', [this.config.database])
    if (!data.length) return
    await this.query(data.map(({ TABLE_NAME }) => `DROP TABLE ${this.sql.escapeId(TABLE_NAME)}`).join('; '))
  }

  async stats() {
    const data = await this._select('information_schema.tables', ['TABLE_NAME', 'TABLE_ROWS', 'DATA_LENGTH'], 'TABLE_SCHEMA = ?', [this.config.database])
    const stats: Driver.Stats = { size: 0 }
    stats.tables = Object.fromEntries(data.map(({ TABLE_NAME: name, TABLE_ROWS: count, DATA_LENGTH: size }) => {
      stats.size += size
      return [name, { count, size }]
    }))
    return stats
  }

  async get(sel: Executable, modifier: Modifier) {
    const { table, fields, query, model } = sel
    const filter = this.sql.parseQuery(query)
    if (filter === '0') return []
    const { limit, offset, sort } = modifier
    const keys = this._joinKeys(this._inferFields(table, fields ? Object.keys(fields) : null))
    let sql = `SELECT ${keys} FROM ${table} _${table} WHERE ${filter}`
    if (sort.length) sql += ' ORDER BY ' + sort.map(([key, order]) => `${backtick(key['$'][1])} ${order}`).join(', ')
    if (limit < Infinity) sql += ' LIMIT ' + limit
    if (offset > 0) sql += ' OFFSET ' + offset
    return this.queue(sql).then((data) => {
      return data.map((row) => model.parse(row))
    })
  }

  async eval(sel: Executable, expr: Eval.Expr) {
    const { table, query } = sel
    const filter = this.sql.parseQuery(query)
    const output = this.sql.parseEval(expr)
    const [data] = await this.queue(`SELECT ${output} AS value FROM ${table} WHERE ${filter}`)
    return data.value
  }

  private toUpdateExpr(table: string, item: any, field: string, upsert: boolean) {
    const escaped = backtick(field)

    // update directly
    if (field in item) {
      if (isEvalExpr(item[field]) || !upsert) {
        return this.sql.parseEval(item[field], table, field)
      } else {
        return `VALUES(${escaped})`
      }
    }

    // update with json_set
    const valueInit = `ifnull(${escaped}, '{}')`
    let value = valueInit
    for (const key in item) {
      if (!key.startsWith(field + '.')) continue
      const rest = key.slice(field.length + 1).split('.')
      value = `json_set(${value}, '$${rest.map(key => `."${key}"`).join('')}', ${this.sql.parseEval(item[key])})`
    }

    if (value === valueInit) {
      return escaped
    } else {
      return value
    }
  }

  async set(sel: Executable, data: {}) {
    const { model, query, table } = sel
    const filter = this.sql.parseQuery(query)
    const { fields } = model
    if (filter === '0') return
    const updateFields = [...new Set(Object.keys(data).map((key) => {
      return Object.keys(fields).find(field => field === key || key.startsWith(field + '.'))
    }))]

    const update = updateFields.map((field) => {
      const escaped = backtick(field)
      return `${escaped} = ${this.toUpdateExpr(table, data, field, false)}`
    }).join(', ')

    await this.query(`UPDATE ${table} SET ${update} WHERE ${filter}`)
  }

  async remove(sel: Executable) {
    const { query, table } = sel
    const filter = this.sql.parseQuery(query)
    if (filter === '0') return
    await this.query('DELETE FROM ?? WHERE ' + filter, [table])
  }

  async create(sel: Executable, data: {}) {
    const { table, model } = sel
    const formatted = model.format(data)
    const { autoInc, primary } = model
    const keys = Object.keys(formatted)
    const header = await this.query<OkPacket>(
      `INSERT INTO ?? (${this._joinKeys(keys)}) VALUES (${keys.map(() => '?').join(', ')})`,
      [table, ...this._formatValues(table, formatted, keys)],
    )
    if (!autoInc) return data as any
    return { ...data, [primary as string]: header.insertId } as any
  }

  async upsert(sel: Executable, data: any[], keys: string[]) {
    if (!data.length) return
    const { model, table, ref } = sel

    const merged = {}
    const insertion = data.map((item) => {
      Object.assign(merged, item)
      return model.format(executeUpdate(model.create(), item, ref))
    })
    const initFields = Object.keys(model.fields)
    const dataFields = [...new Set(Object.keys(merged).map((key) => {
      return initFields.find(field => field === key || key.startsWith(field + '.'))
    }))]
    const updateFields = difference(dataFields, keys)

    const createFilter = (item: any) => this.sql.parseQuery(pick(item, keys))
    const createMultiFilter = (items: any[]) => {
      if (items.length === 1) {
        return createFilter(items[0])
      } else if (keys.length === 1) {
        const key = keys[0]
        return this.sql.parseQuery({ [key]: items.map(item => item[key]) })
      } else {
        return items.map(createFilter).join(' OR ')
      }
    }

    const update = updateFields.map((field) => {
      const escaped = backtick(field)
      const branches: Dict<any[]> = {}
      data.forEach((item) => {
        (branches[this.toUpdateExpr(table, item, field, true)] ??= []).push(item)
      })

      const entries = Object.entries(branches)
        .map(([expr, items]) => [createMultiFilter(items), expr])
        .sort(([a], [b]) => a.length - b.length)
        .reverse()

      let value = entries[0][1]
      for (let index = 1; index < entries.length; index++) {
        value = `if(${entries[index][0]}, ${entries[index][1]}, ${value})`
      }
      return `${escaped} = ${value}`
    }).join(', ')

    const placeholder = `(${initFields.map(() => '?').join(', ')})`
    await this.query(
      `INSERT INTO ${this.sql.escapeId(table)} (${this._joinKeys(initFields)}) VALUES ${data.map(() => placeholder).join(', ')}
      ON DUPLICATE KEY UPDATE ${update}`,
      [].concat(...insertion.map(item => this._formatValues(table, item, initFields))),
    )
  }
}

export default MySQLDriver
