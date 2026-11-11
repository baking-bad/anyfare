import { sql } from 'drizzle-orm';
import { bigint, check, date, doublePrecision, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

import type { EndpointNumbers, JsonObject, RecentPeriod, ServicePage, StatsPeriod } from '@anyfare/core';

// The public numbers, as the workers' counts wrote them. A count writes only the rows whose numbers
// changed and deletes the rows that left its set, so a row's time is when its numbers last changed: the
// last complete count of its kind (`run:recent`, `run:all`) vouches for every row it left in place.
// Public reads come here, never to payments, except for a host or an endpoint with no row. No row holds an
// account ID or a key ID. A host or a path is part of a key only as its md5, so a key stays short whatever
// a buyer called. Times come from the Clock port, never from column defaults.

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
const periodList = sql.raw(['today', '7d', '30d', 'all'].map(period => `'${period}'`).join(', '));

/**
 * Ready answers of the platform: its numbers of today, 7 and 30 days and of all time, the services'
 * totals, each period's top lists, the live numbers' base, and when each kind of count last completed.
 */
export const statsAnswers = pgTable('stats_answers', {
  key: text('key').primaryKey(),
  answer: jsonb('answer').$type<JsonObject>().notNull(),
  // The time the count that wrote it counted to
  countedAt: time('counted_at').notNull(),
});

/**
 * The services with pages of their own, at most the configured number, by paid calls over 30 days: one
 * row each for the public list's sort and search, with its numbers over 30 days.
 */
export const statsServices = pgTable('stats_services', {
  // The md5 of the host
  hostHash: text('host_hash').primaryKey(),
  // At most 259 characters: a longer host is counted, never stored
  host: text('host').notNull(),
  paidEndpoints: integer('paid_endpoints').notNull(),
  // In micro-USD: the cheapest last quote of its endpoints with a paid call in 30 days. Null: none has one.
  priceFrom: bigint('price_from', { mode: 'bigint' }),
  calls: integer('calls').notNull(),
  buyers: integer('buyers').notNull(),
  // In micro-USD
  volume: bigint('volume', { mode: 'bigint' }).notNull(),
  // Null without a finished call
  successRate: doublePrecision('success_rate'),
  p50Ms: integer('p50_ms'),
  // Paid calls per UTC day, the last 30, oldest first
  trend: jsonb('trend').$type<number[]>().notNull(),
  countedAt: time('counted_at').notNull(),
  // When its first routed endpoint was listed. Null: none is.
  listedAt: time('listed_at'),
}, table => [
  check('stats_services_host_check', sql`length(${table.host}) <= 259`),
]);

/** Each stored service's page of each period, without its endpoints. */
export const statsServicePages = pgTable('stats_service_pages', {
  hostHash: text('host_hash').notNull(),
  period: text('period').$type<StatsPeriod>().notNull(),
  answer: jsonb('answer').$type<ServicePage>().notNull(),
  countedAt: time('counted_at').notNull(),
}, table => [
  primaryKey({ name: 'stats_service_pages_pkey', columns: [table.hostHash, table.period] }),
  check('stats_service_pages_period_check', sql`${table.period} in (${periodList})`),
]);

/**
 * The endpoints each stored service keeps, at most 100, by paid calls over 30 days, with the numbers of
 * today, 7 and 30 days, and of all time once the all-time count has reached them.
 */
export const statsEndpoints = pgTable('stats_endpoints', {
  hostHash: text('host_hash').notNull(),
  // The md5 of the path
  pathHash: text('path_hash').notNull(),
  // At most 2,048 characters: a longer path is counted, never stored
  path: text('path').notNull(),
  method: text('method'),
  // In micro-USD: the routed endpoint's last quote
  price: bigint('price', { mode: 'bigint' }),
  recent: jsonb('recent').$type<Record<RecentPeriod, EndpointNumbers>>().notNull(),
  // Paid calls of the last 14 UTC days to the count's, oldest first
  daily: jsonb('daily').$type<number[]>().notNull(),
  countedAt: time('counted_at').notNull(),
  all: jsonb('all').$type<EndpointNumbers>(),
  allCountedAt: time('all_counted_at'),
}, table => [
  primaryKey({ name: 'stats_endpoints_pkey', columns: [table.hostHash, table.pathHash] }),
  check('stats_endpoints_path_check', sql`length(${table.path}) <= 2048`),
]);

/**
 * Today's buyers as the frequent count saw them, each as the md5 of what tells it apart, so the live
 * numbers count a buyer of the calls since that count once. At most 100,000 a day.
 */
export const statsBuyers = pgTable('stats_buyers', {
  day: date('day', { mode: 'string' }).notNull(),
  buyerHash: text('buyer_hash').notNull(),
}, table => [
  primaryKey({ name: 'stats_buyers_pkey', columns: [table.day, table.buyerHash] }),
]);
