// @flow

// don't import the whole utils/ here!
import type { LokiMemoryAdapter } from './type'
import invariant from '../../utils/common/invariant'
import logger from '../../utils/common/logger'
import type { ResultCallback } from '../../utils/fp/Result'

import type { RecordId } from '../../Model'
import type { TableName, AppSchema } from '../../Schema'
import type { DirtyRaw } from '../../RawRecord'
import type { SchemaMigrations } from '../../Schema/migrations'
import type { SerializedQuery } from '../../Query'
import type {
  DatabaseAdapter,
  CachedQueryResult,
  CachedFindResult,
  BatchOperation,
  UnsafeExecuteOperations,
} from '../type'
import { devSetupCallback, validateAdapter, validateTable } from '../common'

import LokiDispatcher from './dispatcher'

export type LokiAdapterOptions = $Exact<{
  dbName?: ?string,
  schema: AppSchema,
  migrations?: SchemaMigrations,
  // (true by default) Although web workers may have some throughput benefits, disabling them
  // may lead to lower memory consumption, lower latency, and easier debugging
  useWebWorker?: boolean,
  useIncrementalIndexedDB?: boolean,
  // Called when database failed to set up (initialize) correctly. It's possible that
  // it's some transient IndexedDB error that will be solved by a reload, but it's
  // very likely that the error is persistent (e.g. a corrupted database).
  // Pass a callback to offer to the user to reload the app or log out
  onSetUpError?: (error: Error) => void,
  // Called when underlying IndexedDB encountered a quota exceeded error (ran out of allotted disk space for app)
  // This means that app can't save more data or that it will fall back to using in-memory database only
  // Note that this only works when `useWebWorker: false`
  onQuotaExceededError?: (error: Error) => void,
  // extra options passed to Loki constructor
  extraLokiOptions?: $Exact<{
    autosave?: boolean,
    autosaveInterval?: number,
  }>,
  // extra options passed to IncrementalIDBAdapter constructor
  extraIncrementalIDBOptions?: $Exact<{
    // Called when this adapter is forced to overwrite contents of IndexedDB.
    // This happens if there's another open tab of the same app that's making changes.
    // You might use it as an opportunity to alert user to the potential loss of data
    onDidOverwrite?: () => void,
    // Called when internal IndexedDB version changed (most likely the database was deleted in another browser tab)
    // Pass a callback to force log out in this copy of the app as well
    // (Due to a race condition, it's usually best to just reload the web app)
    // Note that this only works when not using web workers
    onversionchange?: () => void,
    // Called with a chunk (array of Loki documents) before it's saved to IndexedDB/loaded from IDB. You can use it to
    // manually compress on-disk representation for faster database loads.
    // Hint: Hand-written conversion of objects to arrays is very profitable for performance.
    // Note that this only works when not using web workers
    serializeChunk?: (TableName<any>, DirtyRaw[]) => any,
    deserializeChunk?: (TableName<any>, any) => DirtyRaw[],
    // Called when IndexedDB fetch has begun. Use this as an opportunity to execute code concurrently
    // while IDB does work on a separate thread.
    // Note that this only works when not using web workers
    onFetchStart?: () => void,
  }>,
  // -- internal --
  _testLokiAdapter?: LokiMemoryAdapter,
  _onFatalError?: (error: Error) => void, // (experimental)
  _betaLoki?: boolean, // (experimental)
}>

export default class LokiJSAdapter implements DatabaseAdapter {
  _dispatcher: LokiDispatcher

  schema: AppSchema

  migrations: ?SchemaMigrations

  _options: LokiAdapterOptions

  constructor(options: LokiAdapterOptions): void {
    this._options = options
    const { schema, migrations } = options

    const useWebWorker = options.useWebWorker ?? process.env.NODE_ENV !== 'test'
    this._dispatcher = new LokiDispatcher(useWebWorker)

    this.schema = schema
    this.migrations = migrations

    if (process.env.NODE_ENV !== 'production') {
      invariant(
        'useWebWorker' in options,
        'LokiJSAdapter `useWebWorker` option is required. Pass `{ useWebWorker: false }` to adopt the new behavior, or `{ useWebWorker: true }` to supress this warning with no changes',
      )
      if (options.useWebWorker === true) {
        logger.warn(
          'LokiJSAdapter {useWebWorker: true} option is now deprecated. If you rely on this feature, please file an issue',
        )
      }
      invariant(
        'useIncrementalIndexedDB' in options,
        'LokiJSAdapter `useIncrementalIndexedDB` option is required. Pass `{ useIncrementalIndexedDB: true }` to adopt the new behavior, or `{ useIncrementalIndexedDB: false }` to supress this warning with no changes',
      )
      if (options.useIncrementalIndexedDB === false) {
        logger.warn(
          'LokiJSAdapter {useIncrementalIndexedDB: false} option is now deprecated. If you rely on this feature, please file an issue',
        )
      }
      invariant(
        !('indexedDBSerializer' in options),
        'LokiJSAdapter `indexedDBSerializer` option is now `{ extraIncrementalIDBOptions: { serializeChunk, deserializeChunk } }`',
      )
      invariant(
        !('onIndexedDBFetchStart' in options),
        'LokiJSAdapter `onIndexedDBFetchStart` option is now `extraIncrementalIDBOptions: { onFetchStart }`',
      )
      invariant(
        !('onIndexedDBVersionChange' in options),
        'LokiJSAdapter `onIndexedDBVersionChange` option is now `extraIncrementalIDBOptions: { onversionchange }`',
      )
      invariant(
        !('autosave' in options),
        'LokiJSAdapter `autosave` option is now `extraLokiOptions: { autosave }`',
      )
      validateAdapter(this)
    }
    const callback = (result) => devSetupCallback(result, options.onSetUpError)
    this._dispatcher.call('setUp', [options], callback, 'immutable', 'immutable')
  }

  async testClone(options?: $Shape<LokiAdapterOptions> = {}): Promise<LokiJSAdapter> {
    // Ensure data is saved to memory
    // $FlowFixMe
    const driver = this._driver
    driver.loki.close()

    // $FlowFixMe
    return new LokiJSAdapter({
      ...this._options,
      _testLokiAdapter: driver.loki.persistenceAdapter,
      ...options,
    })
  }

  find(table: TableName<any>, id: RecordId, callback: ResultCallback<CachedFindResult>): void {
    validateTable(table, this.schema)
    this._dispatcher.call('find', [table, id], callback, 'immutable', 'shallowCloneDeepObjects')
  }

  query(query: SerializedQuery, callback: ResultCallback<CachedQueryResult>): void {
    validateTable(query.table, this.schema)
    // SerializedQueries are immutable, so we need no copy
    this._dispatcher.call('query', [query], callback, 'immutable', 'shallowCloneDeepObjects')
  }

  queryIds(query: SerializedQuery, callback: ResultCallback<RecordId[]>): void {
    validateTable(query.table, this.schema)
    // SerializedQueries and strings are immutable, so we need no copy
    this._dispatcher.call('queryIds', [query], callback, 'immutable', 'immutable')
  }

  unsafeQueryRaw(query: SerializedQuery, callback: ResultCallback<any[]>): void {
    validateTable(query.table, this.schema)
    // SerializedQueries are immutable, so we need no copy
    this._dispatcher.call('unsafeQueryRaw', [query], callback, 'immutable', 'immutable')
  }

  count(query: SerializedQuery, callback: ResultCallback<number>): void {
    validateTable(query.table, this.schema)
    // SerializedQueries are immutable, so we need no copy
    this._dispatcher.call('count', [query], callback, 'immutable', 'immutable')
  }

  batch(operations: BatchOperation[], callback: ResultCallback<void>): void {
    operations.forEach(([, table]) => validateTable(table, this.schema))
    // batches are only strings + raws which only have JSON-compatible values, rest is immutable
    this._dispatcher.call('batch', [operations], callback, 'shallowCloneDeepObjects', 'immutable')
  }

  getDeletedRecords(table: TableName<any>, callback: ResultCallback<RecordId[]>): void {
    validateTable(table, this.schema)
    this._dispatcher.call('getDeletedRecords', [table], callback, 'immutable', 'immutable')
  }

  destroyDeletedRecords(
    table: TableName<any>,
    recordIds: RecordId[],
    callback: ResultCallback<void>,
  ): void {
    validateTable(table, this.schema)
    this._dispatcher.call(
      'batch',
      [recordIds.map((id) => ['destroyPermanently', table, id])],
      callback,
      'immutable',
      'immutable',
    )
  }

  unsafeResetDatabase(callback: ResultCallback<void>): void {
    this._dispatcher.call('unsafeResetDatabase', [], callback, 'immutable', 'immutable')
  }

  unsafeExecute(operations: UnsafeExecuteOperations, callback: ResultCallback<void>): void {
    this._dispatcher.call('unsafeExecute', [operations], callback, 'immutable', 'immutable')
  }

  getLocal(key: string, callback: ResultCallback<?string>): void {
    this._dispatcher.call('getLocal', [key], callback, 'immutable', 'immutable')
  }

  setLocal(key: string, value: string, callback: ResultCallback<void>): void {
    invariant(typeof value === 'string', 'adapter.setLocal() value must be a string')
    this._dispatcher.call('setLocal', [key, value], callback, 'immutable', 'immutable')
  }

  removeLocal(key: string, callback: ResultCallback<void>): void {
    this._dispatcher.call('removeLocal', [key], callback, 'immutable', 'immutable')
  }

  // dev/debug utility
  get _driver(): any {
    // $FlowFixMe
    return this._dispatcher._worker._bridge.driver
  }

  // (experimental)
  _fatalError(error: Error): void {
    this._dispatcher.call('_fatalError', [error], () => {}, 'immutable', 'immutable')
  }

  // (experimental)
  _clearCachedRecords(): void {
    this._dispatcher.call('clearCachedRecords', [], () => {}, 'immutable', 'immutable')
  }

  _debugDignoseMissingRecord(table: TableName<any>, id: RecordId): void {
    const driver = this._driver
    if (driver) {
      const lokiCollection = driver.loki.getCollection(table)
      // if we can find the record by ID, it just means that the record cache ID was corrupted
      const didFindById = !!lokiCollection.by('id', id)
      logger.log(`Did find ${table}#${id} in Loki collection by ID? ${didFindById}`)

      // if we can't, but can filter to it, it means that Loki indices are corrupted
      const didFindByFilter = !!lokiCollection.data.filter((doc) => doc.id === id)
      logger.log(
        `Did find ${table}#${id} in Loki collection by filtering the collection? ${didFindByFilter}`,
      )
    }
  }
}
