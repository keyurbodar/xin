/**
 * A provided service that acts on behalf of its caller carries this: the loader hands each plugin row
 * `service[FOR_ROW](rowId)` instead of the service, so the row cannot claim to be another one. Kernel code gets the
 * service itself, which acts for the owner.
 */
export const FOR_ROW: unique symbol = Symbol("ingle.forRow")

export type RowBound<T> = { readonly [FOR_ROW]: (row: string) => T }
