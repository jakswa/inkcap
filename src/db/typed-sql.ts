import type { SQL, TransactionSQL } from 'bun'

type NamedTag<Row> = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Row[]>

type TypedTags<Q> = {
  readonly [K in keyof Q]: NamedTag<Q[K]>
}

type TxCallback<Q, T> = (tx: TypedTransactionSQL<Q>) => T | Promise<T>

type TypedBegin<Q> = {
  begin<T>(fn: TxCallback<Q, T>): Promise<SQL.ContextCallbackResult<T>>
  begin<T>(
    options: string,
    fn: TxCallback<Q, T>,
  ): Promise<SQL.ContextCallbackResult<T>>
  transaction<T>(fn: TxCallback<Q, T>): Promise<SQL.ContextCallbackResult<T>>
  transaction<T>(
    options: string,
    fn: TxCallback<Q, T>,
  ): Promise<SQL.ContextCallbackResult<T>>
}

type TypedTransactionSQL<Q> = TypedBegin<Q> &
  {
    savepoint<T>(fn: TxCallback<Q, T>): Promise<SQL.ContextCallbackResult<T>>
    savepoint<T>(
      name: string,
      fn: TxCallback<Q, T>,
    ): Promise<SQL.ContextCallbackResult<T>>
  } &
  TransactionSQL &
  TypedTags<Q>

export type TypedSQL<Q> = TypedBegin<Q> & SQL & TypedTags<Q>

const scopedClientMethods = new Set(['begin', 'transaction', 'savepoint'])

export function withTypedQueries<Q>(sql: SQL): TypedSQL<Q> {
  return wrap(sql) as TypedSQL<Q>
}

function wrap(sql: SQL | TransactionSQL) {
  return new Proxy(sql, {
    get(target, prop, receiver) {
      const existing = Reflect.get(target, prop, receiver)

      if (existing !== undefined) {
        if (
          typeof existing === 'function' &&
          typeof prop === 'string' &&
          scopedClientMethods.has(prop)
        ) {
          return scopedMethod({ method: existing, target })
        }

        return existing
      }

      return (strings: TemplateStringsArray, ...values: unknown[]) =>
        target(strings, ...values)
    },
  })
}

function scopedMethod(input: {
  method: (...args: unknown[]) => unknown
  target: SQL | TransactionSQL
}) {
  return (...args: unknown[]) => {
    const wrapped = args.map((arg) =>
      typeof arg === 'function'
        ? (client: SQL | TransactionSQL, ...rest: unknown[]) =>
            (arg as (...callbackArgs: unknown[]) => unknown)(
              wrap(client),
              ...rest,
            )
        : arg,
    )

    return input.method.apply(input.target, wrapped)
  }
}
