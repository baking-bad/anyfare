import type { Stats } from '../api/types';

const atLeast = (all: number, month: number): number => Number.isFinite(month) && month > all ? month : all;

const atLeastText = (all: string, month: string): string => Number(month) > Number(all) ? month : all;

/**
 * The stats as the page shows them. The numbers for "all" are counted less often than the 30 days' (see
 * `allUpdatedAt`), so for a minute or two "all" can read less than "30 days". All time is never less than 30
 * days: where it is, the 30 days' number stands for it.
 */
export const withAllTimeAtLeast30Days = (stats: Stats): Stats => ({
  ...stats,
  calls: { ...stats.calls, all: atLeast(stats.calls.all, stats.calls['30d']) },
  buyers: { ...stats.buyers, all: atLeast(stats.buyers.all, stats.buyers['30d']) },
  services: { ...stats.services, all: atLeast(stats.services.all, stats.services['30d']) },
  volume: { ...stats.volume, all: atLeastText(stats.volume.all, stats.volume['30d']) },
});
