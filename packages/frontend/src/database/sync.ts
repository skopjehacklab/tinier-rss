import type { Readable } from 'svelte/store'
import { waitUntilDefined } from './util'

import '../lib/shim'

import type {
  ApplyRemoteChangesFunction,
  IPersistedContext,
  ISyncProtocol,
  PollContinuation,
  ReactiveContinuation
} from 'dexie-syncable/api'
import type {
  ICreateChange,
  IDatabaseChange,
  IDeleteChange,
  IUpdateChange
} from 'dexie-observable/api'
import type { ChangesObject } from '@cloudy-rss/shared'

const TablesToSync = ['userFeedItemReads', 'userSubscriptions']

enum DatabaseChangeType {
  Create = 1,
  Update = 2,
  Delete = 3
}

const DatabaseChangeTypeMap = {
  [DatabaseChangeType.Create]: 'created' as const,
  [DatabaseChangeType.Update]: 'updated' as const,
  [DatabaseChangeType.Delete]: 'deleted' as const
}

const InverseDatabaseChangeTypeMap = Object.fromEntries(
  Object.entries(DatabaseChangeTypeMap).map(([k, v]) => [v, k])
)

type DexieToBackend<
  ObjectType,
  ChangeType extends IDatabaseChange
> = ChangeType extends ICreateChange
  ? ObjectType
  : ChangeType extends IUpdateChange
  ? Partial<ObjectType>
  : ChangeType extends IDeleteChange
  ? string
  : never

function dexieChangeToBackendChange<T>(change: IDatabaseChange): T | string {
  if (change.type == DatabaseChangeType.Create) return change.obj as T
  if (change.type == DatabaseChangeType.Update) return change.obj as T
  if (change.type == DatabaseChangeType.Delete)
    return Object.assign({}, change.oldObj, { deleted: true }) as T

  throw new Error('Unknown change type')
}

function dexieChangeListToChangesObject(changes: IDatabaseChange[]): ChangesObject {
  let baseChangesObject: ChangesObject = {
    userFeedItemReads: { created: [], updated: [], deleted: [] },
    userSubscriptions: { created: [], updated: [], deleted: [] },
    feeds: { created: [], updated: [], deleted: [] },
    feedItems: { created: [], updated: [], deleted: [] }
  }
  let augmentedChanges = Object.fromEntries(
    changes
      .group(c => c.table)
      .map(([tableName, changes]) => [
        tableName,
        Object.fromEntries(
          changes
            .group(c => DatabaseChangeTypeMap[c.type])
            .map(([type, changes]) => [type, changes.map(dexieChangeToBackendChange)])
        )
      ])
  ) as ChangesObject

  return Object.assign(baseChangesObject, augmentedChanges)
}

function changesObjectToDexieChangelist(changes: ChangesObject): IDatabaseChange[] {
  return Object.entries(changes).flatMap(([tableName, changes]) =>
    Object.entries(changes).flatMap(([type, changes]) =>
      changes.map((change: any) => ({
        table: tableName,
        type: InverseDatabaseChangeTypeMap[type],
        obj: type === 'deleted' ? undefined : change,
        oldObj: type === 'deleted' ? change : undefined
        // TODO: unclear if deleted changes need object ID or not
      }))
    )
  )
}

export class DBSyncronizer implements ISyncProtocol {
  private syncInterval?: ReturnType<typeof setInterval>

  constructor(
    private opts: {
      apiUrl: string
      token: Readable<string | undefined>
      syncInterval?: number
    }
  ) {}
  partialsThreshold?: number | undefined
  sync(
    context: IPersistedContext,
    url: string,
    options: any,
    baseRevision: any,
    syncedRevision: any,
    changes: IDatabaseChange[],
    partial: boolean,
    applyRemoteChanges: ApplyRemoteChangesFunction,
    onChangesAccepted: () => void,
    onSuccess: (continuation: PollContinuation | ReactiveContinuation) => void,
    onError: (error: any, again?: number | undefined) => void
  ): void {
    this.syncAsync({
      context,
      url,
      options,
      baseRevision,
      syncedRevision,
      changes,
      partial,
      applyRemoteChanges,
      onChangesAccepted,
      onSuccess,
      onError
    }).then(
      () => {
        console.log('sync done')
        onSuccess({ again: this.opts.syncInterval ?? 60 * 1000 })
      },
      err => {
        console.error('sync error', err)
        onError(err)
      }
    )
  }

  async syncAsync(args: {
    context: IPersistedContext
    url: string
    options: any
    baseRevision: number
    syncedRevision: number
    changes: IDatabaseChange[]
    partial: boolean
    applyRemoteChanges: ApplyRemoteChangesFunction
    onChangesAccepted: () => void
    onSuccess: (continuation: PollContinuation | ReactiveContinuation) => void
    onError: (error: any, again?: number | undefined) => void
  }): Promise<void> {
    console.log('Syncing from', args.baseRevision, 'last synced revision', args.syncedRevision)

    let { changes, lastUpdatedAt } = await this.pullChanges(args.syncedRevision)
    let incomingDexieChanges = changesObjectToDexieChangelist(changes)
    await args.applyRemoteChanges(incomingDexieChanges, lastUpdatedAt) // will update syncedRevision

    let outgoingDexieChanges = args.changes.filter(c => TablesToSync.includes(c.table))
    if (outgoingDexieChanges.length > 0) {
      let outgoingChanges = dexieChangeListToChangesObject(outgoingDexieChanges)
      await this.pushChanges(outgoingChanges, args.baseRevision)
    }
    args.onChangesAccepted()
  }

  private async pullChanges(
    lastPulledAtStart: number | undefined,
    schemaVersion: number = 1,
    migration: any = {}
  ): Promise<{ changes: ChangesObject; lastUpdatedAt: number }> {
    let currentToken = await waitUntilDefined(this.opts.token)
    console.log('pulling changes:', lastPulledAtStart)

    const urlParams = `lastPulledAt=${
      lastPulledAtStart ?? 0
    }&schemaVersion=${schemaVersion}&migration=${encodeURIComponent(JSON.stringify(migration))}`

    const response = await fetch(`${this.opts.apiUrl}/sync/pull?${urlParams}`, {
      headers: {
        Authorization: `Bearer ${currentToken}`
      }
    })

    if (!response.ok) {
      throw new Error(await response.text())
    }

    const { changes, lastUpdatedAt } = await response.json()
    return { changes, lastUpdatedAt }
  }

  async pushChanges(changes: ChangesObject, lastPulledAt: number | undefined) {
    let currentToken = await waitUntilDefined(this.opts.token)

    console.log('pushing changes', changes, lastPulledAt)

    const response = await fetch(
      `${this.opts.apiUrl}/sync/push?lastPulledAt=${lastPulledAt ?? 0}`,
      {
        method: 'POST',
        body: JSON.stringify(changes),
        headers: {
          Authorization: `Bearer ${currentToken}`
        }
      }
    )
    if (!response.ok) {
      throw new Error(await response.text())
    }
  }
}