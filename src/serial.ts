export type Serial = <T>(work: () => Promise<T>) => Promise<T>

export function serial(): Serial {
  let tail: Promise<void> = Promise.resolve()
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
