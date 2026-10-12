/**
 * Express middleware for the request timeline. The package imports only the
 * Express types, so `express` is an optional peer dependency.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { RequestTimeline, runWithTimeline } from './timeline.js'

/** The timeline that `startTimeline` attached to this response, if any. */
export function requestTimeline(res: Response): RequestTimeline | undefined {
  const tl: unknown = res.locals.timeline
  return tl instanceof RequestTimeline ? tl : undefined
}

/** First middleware: start the clock before any other work. */
export function startTimeline(_req: Request, res: Response, next: NextFunction): void {
  const tl = new RequestTimeline()
  tl.startRequest()
  res.locals.timeline = tl
  runWithTimeline(tl, next)
}

/**
 * Record a middleware as a span. The wrapper also restores the timeline when
 * the middleware calls `next`, because a callback from a stream or a socket
 * (a body parser, a JWT key fetch) runs outside the request's context.
 */
export function timedMiddleware(name: string, mw: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const tl = requestTimeline(res)
    if (!tl) return mw(req, res, next)
    const span = tl.open(name)
    return mw(req, res, (err?: unknown) => {
      tl.close(span)
      runWithTimeline(tl, () => next(err as Parameters<NextFunction>[0]))
    })
  }
}
