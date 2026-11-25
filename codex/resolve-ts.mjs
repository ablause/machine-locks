// The engine imports its siblings without an extension, as the Claude Code mod's bundler resolves them; Node needs `.ts`.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  },
})
