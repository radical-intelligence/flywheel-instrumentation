/**
 * Runs the contract suite under node:test. Each case in contract.ts becomes
 * one top-level test. Top-level tests in one file run in order, and the
 * first case needs that order (see the contract.ts header).
 */
import { test } from 'node:test'
import { contractCases } from './contract.js'

for (const c of contractCases) test(c.name, c.run)
