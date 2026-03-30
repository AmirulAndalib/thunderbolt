/**
 * Bridge between the deep link handler and MCP OAuth flow.
 *
 * Only one MCP OAuth flow can be active at a time. The MCP connection code
 * calls `waitForMcpOAuthCode()` to get a promise, then the deep link handler
 * calls `deliverMcpOAuthCode()` when the callback arrives.
 */

type PendingOAuth = {
  resolve: (code: string) => void
  reject: (error: Error) => void
}

let pending: PendingOAuth | null = null

/** Returns a promise that resolves with the authorization code from the deep link callback. */
export const waitForMcpOAuthCode = (): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    pending = { resolve, reject }
  })

/** Called by the deep link handler when an MCP OAuth callback arrives with a code. */
export const deliverMcpOAuthCode = (code: string) => {
  if (!pending) {return}
  pending.resolve(code)
  pending = null
}

/** Called by the deep link handler when an MCP OAuth callback arrives with an error. */
export const failMcpOAuthCode = (error: string) => {
  if (!pending) {return}
  pending.reject(new Error(error))
  pending = null
}

/** Returns true if an MCP OAuth flow is waiting for a callback. */
export const hasPendingMcpOAuth = (): boolean => pending !== null
