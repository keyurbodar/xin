import { compile, obj, opt, str, unknown, type ValidationError } from "@earendil-works/pi-schema"
import { messageOf } from "../../src/errors.ts"
import { isPackageName } from "../../src/npmname.ts"

export const REQUEST_TIMEOUT_MS = 10_000

export type RegistryDist = { readonly tarball: string; readonly integrity?: string }

export type VersionDocument = {
  readonly version: string
  readonly xin?: unknown
  readonly readme?: string
  readonly dist: RegistryDist
}

export type RegistryFailure =
  | { readonly kind: "timeout"; readonly message: string }
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "http"; readonly status: number; readonly message: string }
  | { readonly kind: "parse"; readonly message: string }
  | { readonly kind: "input"; readonly message: string }

export type RegistryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RegistryFailure }

const DistSchema = obj({ tarball: str({ minLength: 1 }), integrity: opt(str({ minLength: 1 })) }, { open: true })

const VersionDocumentSchema = obj(
  {
    version: str({ minLength: 1 }),
    xin: opt(unknown()),
    readme: opt(str()),
    dist: DistSchema,
  },
  { open: true },
)

const versionCheck = compile(VersionDocumentSchema)

const VERSION_OR_TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

export async function fetchVersion(
  fetchImpl: typeof fetch,
  baseUrl: string,
  name: string,
  version: string,
): Promise<RegistryResult<VersionDocument>> {
  const path = packagePath(name)
  if (path === undefined) return badInput(`invalid package name ${name}`)
  if (!VERSION_OR_TAG.test(version)) return badInput(`invalid version ${version}`)
  const found = await fetchJson(fetchImpl, `${baseUrl.replace(/\/+$/, "")}/${path}/${version}`)
  if (!found.ok) return found
  if (!versionCheck.check(found.value)) return badDocument(versionCheck.errors(found.value))
  const document = found.value
  return {
    ok: true,
    value: {
      version: document.version,
      dist: document.dist,
      ...(document.xin === undefined ? {} : { xin: document.xin }),
      ...(document.readme === undefined ? {} : { readme: document.readme }),
    },
  }
}

export async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<RegistryResult<unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const pending = fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal })
    const response = await untilAborted(pending, controller.signal)
    if (!response.ok) {
      return { ok: false, error: { kind: "http", status: response.status, message: `HTTP ${response.status}` } }
    }
    return { ok: true, value: await untilAborted(response.json(), controller.signal) }
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: { kind: "timeout", message: "request timed out" } }
    if (error instanceof SyntaxError) return { ok: false, error: { kind: "parse", message: messageOf(error) } }
    return { ok: false, error: requestFailure(error) }
  } finally {
    clearTimeout(timer)
  }
}

function packagePath(name: string): string | undefined {
  return isPackageName(name) ? name.replace("/", "%2f") : undefined
}

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener("abort", abort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

function requestFailure(error: unknown): RegistryFailure {
  const name = error instanceof Error ? error.name : ""
  if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout", message: messageOf(error) }
  return { kind: "network", message: messageOf(error) }
}

function badDocument(errors: readonly ValidationError[]): RegistryResult<never> {
  const details = errors
    .slice(0, 3)
    .map((error) => `${error.path}: ${error.message}`)
    .join("; ")
  return { ok: false, error: { kind: "parse", message: details === "" ? "invalid document" : details } }
}

function badInput(message: string): RegistryResult<never> {
  return { ok: false, error: { kind: "input", message } }
}
