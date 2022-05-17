import { $, Database } from 'minato'
import { omit } from 'cosmokit'
import { expect } from 'chai'

interface Bar {
  id?: number
  text?: string
  num?: number
  bool?: boolean
  list?: string[]
  timestamp?: Date
  date?: Date
  time?: Date
}

interface Baz {
  ida?: number
  idb?: string
  value?: string
}

interface Tables {
  temp2: Bar
  temp3: Baz
}

function OrmOperations(database: Database<Tables>) {
  database.extend('temp2', {
    id: 'unsigned',
    text: 'string',
    num: 'integer',
    bool: 'boolean',
    list: 'list',
    timestamp: 'timestamp',
    date: 'date',
    time: 'time',
  }, {
    autoInc: true,
  })

  database.extend('temp3', {
    ida: 'unsigned',
    idb: 'string',
    value: 'string',
  }, {
    primary: ['ida', 'idb'],
  })
}

namespace OrmOperations {
  const merge = <T>(a: T, b: Partial<T>): T => ({ ...a, ...b })

  const magicBorn = new Date('1970/08/17')

  const barTable: Bar[] = [
    { id: 1, bool: true },
    { id: 2, text: 'pku' },
    { id: 3, num: 1989 },
    { id: 4, list: ['1', '1', '4'] },
    { id: 5, timestamp: magicBorn },
    { id: 6, date: magicBorn },
    { id: 7, time: new Date('1970-01-01 12:00:00') },
  ]

  const bazTable: Baz[] = [
    { ida: 1, idb: 'a', value: 'a' },
    { ida: 2, idb: 'a', value: 'b' },
    { ida: 1, idb: 'b', value: 'c' },
    { ida: 2, idb: 'b', value: 'd' },
  ]

  async function setup<K extends keyof Tables>(database: Database<Tables>, name: K, table: Tables[K][]) {
    await database.remove(name, {})
    const result: Tables[K][] = []
    for (const item of table) {
      result.push(await database.create(name, item as any))
    }
    return result
  }

  export const create = function Create(database: Database<Tables>) {
    it('auto increment primary key', async () => {
      const table = barTable.map(bar => merge(database.tables.temp2.create(), bar))
      for (const index in barTable) {
        const bar = await database.create('temp2', omit(barTable[index], ['id']))
        barTable[index].id = bar.id
        expect(bar).to.have.shape(table[index])
      }
      for (const obj of table) {
        await expect(database.get('temp2', { id: obj.id })).to.eventually.have.shape([obj])
      }
      await expect(database.get('temp2', {})).to.eventually.have.shape(table)
    })

    it('specify primary key', async () => {
      for (const obj of bazTable) {
        await expect(database.create('temp3', obj)).eventually.shape(obj)
      }
      for (const obj of bazTable) {
        await expect(database.get('temp3', { ida: obj.ida, idb: obj.idb })).eventually.shape([obj])
      }
    })

    it('duplicate primary key', async () => {
      await expect(database.create('temp2', { id: barTable[0].id })).eventually.rejected
      await expect(database.create('temp3', { ida: 1, idb: 'a' })).eventually.rejected
    })

    it('parallel create', async () => {
      await database.remove('temp2', {})
      await Promise.all([...Array(5)].map(() => database.create('temp2', {})))
      const result = await database.get('temp2', {})
      expect(result).length(5)
      const ids = result.map(e => e.id).sort((a, b) => a - b)
      const min = Math.min(...ids)
      expect(ids.map(id => id - min + 1)).shape([1, 2, 3, 4, 5])
      await database.remove('temp2', {})
    })
  }

  export const get = function Get(database: Database<Tables>) {
    it('sort', async () => {
      let table = await setup(database, 'temp3', bazTable)
      expect(table.map(e => e.ida + e.idb)).to.deep.equal(['1a', '2a', '1b', '2b'])
      table = await database.get('temp3', {}, { sort: { ida: 'desc', idb: 'asc' } })
      expect(table.map(e => e.ida + e.idb)).to.deep.equal(['2a', '2b', '1a', '1b'])
    })
  }

  export const set = function Set(database: Database<Tables>) {
    it('basic support', async () => {
      const table = await setup(database, 'temp2', barTable)
      const data = table.find(bar => bar.timestamp)
      data.text = 'thu'
      const magicIds = table.slice(0, 2).map((data) => {
        data.text = 'thu'
        return data.id
      })
      await expect(database.set('temp2', {
        $or: [
          { id: magicIds },
          { timestamp: magicBorn },
        ],
      }, { text: 'thu' })).eventually.fulfilled
      await expect(database.get('temp2', {})).to.eventually.have.shape(table)
    })

    it('null override', async () => {
      const table = await setup(database, 'temp2', barTable)
      const data = table.find(bar => bar.timestamp)
      data.text = null
      await expect(database.set('temp2', { timestamp: { $exists: true } }, { text: null })).eventually.fulfilled
      await expect(database.get('temp2', {})).to.eventually.have.shape(table)
    })

    it('using expressions', async () => {
      const table = await setup(database, 'temp2', barTable)
      table[1].num = table[1].id * 2
      table[2].num = table[2].id * 2
      await expect(database.set('temp2', [table[1].id, table[2].id, 9], row => ({
        num: $.multiply(2, row.id),
      }))).eventually.fulfilled
      await expect(database.get('temp2', {})).to.eventually.have.shape(table)
    })
  }

  export const upsert = function Upsert(database: Database<Tables>) {
    it('update existing records', async () => {
      const table = await setup(database, 'temp2', barTable)
      const data = [
        { id: table[0].id, text: 'thu' },
        { id: table[1].id, num: 1911 },
      ]
      data.forEach(update => {
        const index = table.findIndex(obj => obj.id === update.id)
        table[index] = merge(table[index], update)
      })
      await expect(database.upsert('temp2', data)).eventually.fulfilled
      await expect(database.get('temp2', {})).to.eventually.have.shape(table)
    })

    it('insert new records', async () => {
      const table = await setup(database, 'temp2', barTable)
      const data = [
        { id: table[table.length - 1].id + 1, text: 'wmlake' },
        { id: table[table.length - 1].id + 2, text: 'bytower' },
      ]
      table.push(...data.map(bar => merge(database.tables.temp2.create(), bar)))
      await expect(database.upsert('temp2', data)).eventually.fulfilled
      await expect(database.get('temp2', {})).to.eventually.have.shape(table)
    })

    it('using expressions', async () => {
      const table = await setup(database, 'temp2', barTable)
      const data2 = table.find(item => item.id === 2)
      const data3 = table.find(item => item.id === 3)
      const data9 = table.find(item => item.id === 9)
      data2.num = data2.id * 2
      data3.num = data3.num + 3
      expect(data9).to.be.undefined
      table.push({ id: 9, num: 999 })
      await expect(database.upsert('temp2', row => [
        { id: 2, num: $.multiply(2, row.id) },
        { id: 3, num: $.add(3, row.num) },
        { id: 9, num: 999 },
      ])).eventually.fulfilled
      await expect(database.get('temp2', {})).to.eventually.have.shape(table)
    })
  }

  export const remove = function Remove(database: Database<Tables>) {
    it('basic support', async () => {
      await setup(database, 'temp3', bazTable)
      await expect(database.remove('temp3', { ida: 1, idb: 'a' })).eventually.fulfilled
      await expect(database.get('temp3', {})).eventually.length(3)
      await expect(database.remove('temp3', { ida: 1, idb: 'b', value: 'b' })).eventually.fulfilled
      await expect(database.get('temp3', {})).eventually.length(3)
      await expect(database.remove('temp3', { idb: 'b' })).eventually.fulfilled
      await expect(database.get('temp3', {})).eventually.length(1)
      await expect(database.remove('temp3', {})).eventually.fulfilled
      await expect(database.get('temp3', {})).eventually.length(0)
    })

    it('advanced query', async () => {
      const table = await setup(database, 'temp2', barTable)
      await expect(database.remove('temp2', { id: { $gt: table[1].id } })).eventually.fulfilled
      await expect(database.get('temp2', {})).eventually.length(2)
      await expect(database.remove('temp2', { id: { $lte: table[1].id } })).eventually.fulfilled
      await expect(database.get('temp2', {})).eventually.length(0)
    })
  }

  export const evaluate = function Evaluate(database: Database<Tables>) {
    it('plain expression', async () => {
      await setup(database, 'temp3', bazTable)
      await expect(database.eval('temp3', 100)).eventually.equal(100)
    })

    it('basic support', async () => {
      await setup(database, 'temp3', bazTable)
      await expect(database.eval('temp3', { $sum: 'ida' })).eventually.equal(6)
      await expect(database.eval('temp3', { $count: 'idb' })).eventually.equal(2)
    })

    it('inner expressions', async () => {
      await setup(database, 'temp3', bazTable)
      await expect(database.eval('temp3', {
        $avg: {
          $multiply: [2, { $: 'ida' }, { $: 'ida' }],
        },
      })).eventually.equal(5)
    })

    it('outer expressions', async () => {
      await setup(database, 'temp3', bazTable)
      await expect(database.eval('temp3', {
        $subtract: [
          { $sum: 'ida' },
          { $count: 'idb' },
        ],
      })).eventually.equal(4)
    })
  }

  export const stats = function Stats(database: Database<Tables>) {
    it('basic support', async () => {
      await expect(database.stats()).to.eventually.ok
    })
  }
}

export default OrmOperations
