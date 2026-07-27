import { processCensusReport } from "./census.js";
import {
  capsGet,
  capsSearch,
  type CapsSearchHit,
  type DetailEnricher,
} from "./search.js";
import type { CapsStore } from "./store.js";
import type {
  CensusResult,
  CensusTrustedContext,
} from "./types.js";

export class CapsService {
  constructor(
    private readonly store: CapsStore,
    private readonly detailEnricher?: DetailEnricher,
  ) {}

  public reportCensus(
    roster: unknown,
    context: CensusTrustedContext,
  ): CensusResult {
    return processCensusReport(this.store, roster, context);
  }

  public search(
    query: unknown,
    options: unknown,
    context: CensusTrustedContext,
  ): CapsSearchHit[] {
    return capsSearch(this.store, query, options, context);
  }

  public get(
    id: unknown,
    context: CensusTrustedContext,
  ): Promise<Record<string, unknown> | null> {
    return capsGet(this.store, id, context, this.detailEnricher);
  }
}
