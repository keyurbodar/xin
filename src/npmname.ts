export const MAX_PACKAGE_NAME = 214

const NPM_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/

export const isPackageName = (name: string): boolean => name.length <= MAX_PACKAGE_NAME && NPM_NAME.test(name)
