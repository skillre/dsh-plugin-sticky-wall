/**
 * Typed Client-side API over the Host's exact Connection route.
 *
 * The browser RPC caller validates the envelope and the correlation id, so this
 * layer only has to unwrap the endpoint's own result: `ok: true` returns the
 * value, `ok: false` throws an {@link ActionError} carrying the Host's stable
 * code and message. No Host object, function or live Session value crosses this
 * boundary — only lossless JSON.
 */

import type { ClientConnectionLike, RpcResult } from './contracts.js'
import { ENDPOINT } from '../types.js'
import type { MutationResult, Note, NoteInput, NoteLayout, NotePatch, WallRequest, WallSnapshot } from '../types.js'

/** Failure raised by the Host; `code` is stable enough to switch on. */
export class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/** The one API face the view uses. */
export interface ClientApi {
  list(includeArchived: boolean, sort: 'pinned' | 'created' | 'updated', signal?: AbortSignal): Promise<Note[]>
  create(input: NoteInput, signal?: AbortSignal): Promise<Note>
  update(id: string, patch: NotePatch, signal?: AbortSignal): Promise<Note>
  archive(ids: string[], archived: boolean, signal?: AbortSignal): Promise<Note[]>
  remove(ids: string[], signal?: AbortSignal): Promise<string[]>
  clearArchived(signal?: AbortSignal): Promise<string[]>
  move(id: string, layout: NoteLayout, signal?: AbortSignal): Promise<Note>
  arrange(signal?: AbortSignal): Promise<Note[]>
}

/** Unwrap one endpoint result, converting a failure into a thrown error. */
function unwrap<T>(result: RpcResult<T>): T {
  if (result === null || typeof result !== 'object' || !('ok' in result)) throw new ActionError('invalid-response', 'The Host returned an invalid sticky-wall response.')
  if (!result.ok) throw new ActionError(result.error.code, result.error.message, result.error.details)
  return result.value
}

/** Create the API bound to this plugin's Fiber lifetime. */
export function createApi(connection: ClientConnectionLike, lifetime: AbortSignal): ClientApi {
  const call = async <T>(request: WallRequest, signal?: AbortSignal): Promise<T> => {
    const signalToUse = signal === undefined ? lifetime : AbortSignal.any([lifetime, signal])
    return unwrap(await connection.rpc.call<T>('/api', ENDPOINT, request, signalToUse))
  }
  return {
    async list(includeArchived, sort, signal) {
      const value = await call<WallSnapshot>({ action: 'list', includeArchived, sort }, signal)
      return Array.isArray(value?.notes) ? value.notes : []
    },
    async create(input, signal) {
      const value = await call<MutationResult>({ action: 'create', note: input }, signal)
      const note = value?.changed?.[0]
      if (!note) throw new ActionError('invalid-response', 'The Host created no note.')
      return note
    },
    async update(id, patch, signal) {
      const value = await call<MutationResult>({ action: 'update', id, patch }, signal)
      const note = value?.changed?.[0]
      if (!note) throw new ActionError('invalid-response', 'The Host updated no note.')
      return note
    },
    async archive(ids, archived, signal) {
      const value = await call<MutationResult>({ action: 'archive', ids, archived }, signal)
      return Array.isArray(value?.changed) ? value.changed : []
    },
    async remove(ids, signal) {
      const value = await call<MutationResult>({ action: 'delete', ids }, signal)
      return Array.isArray(value?.removed) ? value.removed : []
    },
    async clearArchived(signal) {
      const value = await call<MutationResult>({ action: 'clear-archived' }, signal)
      return Array.isArray(value?.removed) ? value.removed : []
    },
    async move(id, layout, signal) {
      const value = await call<MutationResult>({ action: 'move', id, layout }, signal)
      const note = value?.changed?.[0]
      if (!note) throw new ActionError('invalid-response', 'The Host moved no note.')
      return note
    },
    async arrange(signal) {
      const value = await call<MutationResult>({ action: 'arrange' }, signal)
      return Array.isArray(value?.changed) ? value.changed : []
    },
  }
}
