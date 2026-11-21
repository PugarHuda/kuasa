import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Claim, Policy } from '@kuasa/core';
import { feedbackFor } from '../src/erc8004.js';

const pol = (payer: string, until: number): Policy => ({ holder: 'h', agentPayer: payer, agentToken: 'ee04', mandate: { owner: 'h', id: 'm' }, kind: 'period', limit: 1n, deductible: 0n, premium: 1n, premiumTx: 't', validUntilMs: BigInt(until), validFromMs: 0n, paidOut: 0n, status: 'Active' });
const clm = (policyId: number, kind: Claim['kind'], tag: string): Claim => ({ policyId: BigInt(policyId), kind, amount: 1n, evidence: 'e', orders: [], claimant: 'c', status: { tag } as Claim['status'], payout: 0n });

test('ERC-8004 feedback: paid agent mistakes and merchant losses lower the score, fraud is 0, wrong items are not the agent\'s fault, claim-free expiry is 100', () => {
  const books = [{ cover: 13100n, policies: [pol('A', 10), pol('A', 10), pol('B', 10)], claims: [clm(0, 'AgentMistake', 'Paid'), clm(0, 'WrongItem', 'Paid'), clm(0, 'MerchantLoss', 'Paid'), clm(2, 'AgentMistake', 'Fraud'), clm(0, 'AgentMistake', 'Rejected')] }];
  const f = feedbackFor('A', books, 100);
  assert.deepEqual(f.map((x) => [x.tag2, x.score, x.evidence.claimId ?? x.evidence.status]), [['AgentMistake', 60, '0'], ['MerchantLoss', 30, '2'], ['claim-free', 100, 'Expired']]);
  assert.deepEqual(feedbackFor('B', books, 100).map((x) => [x.tag2, x.score]), [['fraud', 0]]);
});
