export function createUiEnvironment(environment?: NodeJS.ProcessEnv, port?: string, productApiPort?: string): NodeJS.ProcessEnv;
export function createServerEnvironment(environment?: NodeJS.ProcessEnv, mode?: string, port?: string, productApiPort?: string): NodeJS.ProcessEnv;
export function createProductApiEnvironment(environment?: NodeJS.ProcessEnv, mode?: string, port?: string, localServerPort?: string): NodeJS.ProcessEnv;
