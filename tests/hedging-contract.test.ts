// hedging-contract.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Hedge {
  creator: string;
  cropType: string;
  region: string;
  yieldThreshold: number;
  payoutAmount: number;
  stakeAmount: number;
  counterparty: string | null;
  seasonStart: number;
  seasonEnd: number;
  settled: boolean;
  matched: boolean;
  cancelled: boolean;
  hedgeType: string;
  feePaid: number;
}

interface Stake {
  amount: number;
}

interface Settlement {
  actualYield: number;
  winner: string;
  payout: number;
  timestamp: number;
}

interface ContractState {
  hedges: Map<number, Hedge>;
  stakes: Map<string, Stake>; // Key: `${hedge-id}-${participant}`
  settlements: Map<number, Settlement>;
  hedgeCounter: number;
  totalFeesCollected: number;
  paused: boolean;
  contractOwner: string;
  blockHeight: number; // Mock block height
}

// Mock OracleContract
class MockOracle {
  getYield(cropType: string, region: string, seasonEnd: number): ClarityResponse<number> {
    // Mock yield data based on inputs for testing
    if (cropType === "corn" && region === "RegionX") {
      return { ok: true, value: 450 }; // 4.5 tons/ha * 100
    }
    return { ok: false, value: 109 };
  }
}

// Mock contract implementation
class HedgingContractMock {
  private state: ContractState = {
    hedges: new Map(),
    stakes: new Map(),
    settlements: new Map(),
    hedgeCounter: 0,
    totalFeesCollected: 0,
    paused: false,
    contractOwner: "deployer",
    blockHeight: 1000,
  };

  private oracle = new MockOracle();

  private ERR_UNAUTHORIZED = 100;
  private ERR_INVALID_PARAMS = 101;
  private ERR_HEDGE_NOT_FOUND = 102;
  private ERR_ALREADY_SETTLED = 103;
  private ERR_SEASON_NOT_ENDED = 104;
  private ERR_INSUFFICIENT_STAKE = 105;
  private ERR_INVALID_COUNTERPARTY = 106;
  private ERR_HEDGE_EXPIRED = 107;
  private ERR_INVALID_STATE = 108;
  private ERR_ORACLE_FAIL = 109;
  private ERR_TRANSFER_FAIL = 110; // Not used in mock
  private ERR_ALREADY_MATCHED = 111;
  private ERR_CANCELLATION_NOT_ALLOWED = 112;
  private ERR_FEE_CALCULATION = 113; // Not used
  private PLATFORM_FEE_PCT = 5;
  private MIN_STAKE = 1000;
  private MAX_HEDGE_DURATION = 52560;

  // Helper to simulate block height advance
  advanceBlockHeight(blocks: number) {
    this.state.blockHeight += blocks;
  }

  private calculateFee(amount: number): number {
    return Math.floor((amount * this.PLATFORM_FEE_PCT) / 1000);
  }

  // In mock, we don't actually transfer STX, just simulate
  private refundStake(hedgeId: number, participant: string): ClarityResponse<boolean> {
    const key = `${hedgeId}-${participant}`;
    const stake = this.state.stakes.get(key);
    if (!stake) return { ok: false, value: this.ERR_INSUFFICIENT_STAKE };
    this.state.stakes.delete(key);
    return { ok: true, value: true };
  }

  private settleInternal(hedgeId: number, actualYield: number): ClarityResponse<string> {
    const hedge = this.state.hedges.get(hedgeId);
    if (!hedge) return { ok: false, value: this.ERR_HEDGE_NOT_FOUND };
    if (hedge.settled) return { ok: false, value: this.ERR_ALREADY_SETTLED };
    if (this.state.blockHeight < hedge.seasonEnd) return { ok: false, value: this.ERR_SEASON_NOT_ENDED };
    if (!hedge.counterparty) return { ok: false, value: this.ERR_INVALID_COUNTERPARTY };

    const isBelow = hedge.hedgeType === "below";
    const conditionMet = isBelow ? actualYield < hedge.yieldThreshold : actualYield > hedge.yieldThreshold;
    const winner = conditionMet ? hedge.creator : hedge.counterparty;
    const loser = conditionMet ? hedge.counterparty : hedge.creator;

    // Simulate payout transfer (no actual transfer in mock)
    this.refundStake(hedgeId, hedge.creator);
    this.refundStake(hedgeId, hedge.counterparty);

    this.state.settlements.set(hedgeId, {
      actualYield,
      winner,
      payout: hedge.payoutAmount,
      timestamp: this.state.blockHeight,
    });

    hedge.settled = true;
    this.state.hedges.set(hedgeId, hedge);

    return { ok: true, value: winner };
  }

  createHedge(
    caller: string,
    cropType: string,
    region: string,
    yieldThreshold: number,
    payoutAmount: number,
    stakeAmount: number,
    seasonStart: number,
    seasonEnd: number,
    hedgeType: string
  ): ClarityResponse<number> {
    if (this.state.paused) return { ok: false, value: this.ERR_INVALID_STATE };
    if (stakeAmount < this.MIN_STAKE) return { ok: false, value: this.ERR_INSUFFICIENT_STAKE };
    if (seasonEnd <= seasonStart || (seasonEnd - seasonStart) > this.MAX_HEDGE_DURATION) {
      return { ok: false, value: this.ERR_INVALID_PARAMS };
    }
    if (hedgeType !== "below" && hedgeType !== "above") return { ok: false, value: this.ERR_INVALID_PARAMS };
    if (payoutAmount <= 0) return { ok: false, value: this.ERR_INVALID_PARAMS };

    const fee = this.calculateFee(payoutAmount);
    this.state.totalFeesCollected += fee;

    const hedgeId = this.state.hedgeCounter + 1;
    this.state.hedges.set(hedgeId, {
      creator: caller,
      cropType,
      region,
      yieldThreshold,
      payoutAmount,
      stakeAmount,
      counterparty: null,
      seasonStart,
      seasonEnd,
      settled: false,
      matched: false,
      cancelled: false,
      hedgeType,
      feePaid: fee,
    });

    const key = `${hedgeId}-${caller}`;
    this.state.stakes.set(key, { amount: stakeAmount });

    this.state.hedgeCounter = hedgeId;
    return { ok: true, value: hedgeId };
  }

  matchHedge(caller: string, hedgeId: number): ClarityResponse<boolean> {
    const hedge = this.state.hedges.get(hedgeId);
    if (!hedge) return { ok: false, value: this.ERR_HEDGE_NOT_FOUND };
    if (hedge.matched) return { ok: false, value: this.ERR_ALREADY_MATCHED };
    if (hedge.settled) return { ok: false, value: this.ERR_ALREADY_SETTLED };
    if (hedge.cancelled) return { ok: false, value: this.ERR_INVALID_STATE };
    if (caller === hedge.creator) return { ok: false, value: this.ERR_INVALID_COUNTERPARTY };
    if (this.state.blockHeight >= hedge.seasonStart) return { ok: false, value: this.ERR_HEDGE_EXPIRED };

    const fee = this.calculateFee(hedge.payoutAmount);
    this.state.totalFeesCollected += fee;

    hedge.counterparty = caller;
    hedge.matched = true;
    hedge.feePaid += fee;
    this.state.hedges.set(hedgeId, hedge);

    const key = `${hedgeId}-${caller}`;
    this.state.stakes.set(key, { amount: hedge.stakeAmount });

    return { ok: true, value: true };
  }

  settleHedge(hedgeId: number): ClarityResponse<boolean> {
    const hedge = this.state.hedges.get(hedgeId);
    if (!hedge) return { ok: false, value: this.ERR_HEDGE_NOT_FOUND };
    if (!hedge.matched) return { ok: false, value: this.ERR_INVALID_STATE };

    const oracleResp = this.oracle.getYield(hedge.cropType, hedge.region, hedge.seasonEnd);
    if (!oracleResp.ok) return { ok: false, value: this.ERR_ORACLE_FAIL };

    const settleResp = this.settleInternal(hedgeId, oracleResp.value as number);
    return { ok: settleResp.ok, value: settleResp.ok };
  }

  cancelHedge(caller: string, hedgeId: number): ClarityResponse<boolean> {
    const hedge = this.state.hedges.get(hedgeId);
    if (!hedge) return { ok: false, value: this.ERR_HEDGE_NOT_FOUND };
    if (caller !== hedge.creator) return { ok: false, value: this.ERR_UNAUTHORIZED };
    if (hedge.matched) return { ok: false, value: this.ERR_CANCELLATION_NOT_ALLOWED };
    if (hedge.settled) return { ok: false, value: this.ERR_ALREADY_SETTLED };
    if (hedge.cancelled) return { ok: false, value: this.ERR_INVALID_STATE };

    this.refundStake(hedgeId, hedge.creator);

    hedge.cancelled = true;
    this.state.hedges.set(hedgeId, hedge);

    return { ok: true, value: true };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) return { ok: false, value: this.ERR_UNAUTHORIZED };
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) return { ok: false, value: this.ERR_UNAUTHORIZED };
    this.state.paused = false;
    return { ok: true, value: true };
  }

  withdrawFees(caller: string, amount: number): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) return { ok: false, value: this.ERR_UNAUTHORIZED };
    if (amount > this.state.totalFeesCollected) return { ok: false, value: this.ERR_INSUFFICIENT_STAKE };
    this.state.totalFeesCollected -= amount;
    return { ok: true, value: true };
  }

  getHedgeDetails(hedgeId: number): ClarityResponse<Hedge | null> {
    return { ok: true, value: this.state.hedges.get(hedgeId) ?? null };
  }

  getSettlement(hedgeId: number): ClarityResponse<Settlement | null> {
    return { ok: true, value: this.state.settlements.get(hedgeId) ?? null };
  }

  getStake(hedgeId: number, participant: string): ClarityResponse<Stake | null> {
    const key = `${hedgeId}-${participant}`;
    return { ok: true, value: this.state.stakes.get(key) ?? null };
  }

  getTotalFees(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalFeesCollected };
  }

  isPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }

  getHedgeCounter(): ClarityResponse<number> {
    return { ok: true, value: this.state.hedgeCounter };
  }

  getContractOwner(): ClarityResponse<string> {
    return { ok: true, value: this.state.contractOwner };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  farmer: "wallet_1",
  speculator: "wallet_2",
  unauthorized: "wallet_3",
};

describe("HedgingContract", () => {
  let contract: HedgingContractMock;

  beforeEach(() => {
    contract = new HedgingContractMock();
    vi.resetAllMocks();
  });

  it("should create a new hedge position", () => {
    const createResp = contract.createHedge(
      accounts.farmer,
      "corn",
      "RegionX",
      500, // 5 tons/ha
      10000, // payout
      2000, // stake
      1000,
      2000,
      "below"
    );
    expect(createResp).toEqual({ ok: true, value: 1 });

    const details = contract.getHedgeDetails(1);
    expect(details).toEqual({
      ok: true,
      value: expect.objectContaining({
        creator: accounts.farmer,
        cropType: "corn",
        region: "RegionX",
        yieldThreshold: 500,
        payoutAmount: 10000,
        stakeAmount: 2000,
        counterparty: null,
        matched: false,
        settled: false,
        cancelled: false,
        feePaid: 50, // 10000 * 0.005
      }),
    });

    const stake = contract.getStake(1, accounts.farmer);
    expect(stake).toEqual({ ok: true, value: { amount: 2000 } });

    const fees = contract.getTotalFees();
    expect(fees).toEqual({ ok: true, value: 50 });
  });

  it("should prevent creating hedge with invalid params", () => {
    const invalidType = contract.createHedge(
      accounts.farmer,
      "corn",
      "RegionX",
      500,
      10000,
      2000,
      1000,
      2000,
      "invalid"
    );
    expect(invalidType).toEqual({ ok: false, value: 101 });
  });

  it("should match a hedge with counterparty", () => {
    contract.createHedge(
      accounts.farmer,
      "corn",
      "RegionX",
      500,
      10000,
      2000,
      1100,
      2000,
      "below"
    );

    const matchResp = contract.matchHedge(accounts.speculator, 1);
    expect(matchResp).toEqual({ ok: true, value: true });

    const details = contract.getHedgeDetails(1);
    expect(details).toEqual({
      ok: true,
      value: expect.objectContaining({
        counterparty: accounts.speculator,
        matched: true,
        feePaid: 100, // 50 + 50
      }),
    });

    const stake = contract.getStake(1, accounts.speculator);
    expect(stake).toEqual({ ok: true, value: { amount: 2000 } });

    const fees = contract.getTotalFees();
    expect(fees).toEqual({ ok: true, value: 100 });
  });

  it("should allow creator to cancel unmatched hedge", () => {
    contract.createHedge(
      accounts.farmer,
      "corn",
      "RegionX",
      500,
      10000,
      2000,
      1000,
      2000,
      "below"
    );

    const cancelResp = contract.cancelHedge(accounts.farmer, 1);
    expect(cancelResp).toEqual({ ok: true, value: true });

    const details = contract.getHedgeDetails(1);
    expect(details.value?.cancelled).toBe(true);

    // Stake refunded
    expect(contract.getStake(1, accounts.farmer).value).toBeNull();
  });

  it("should pause and unpause contract", () => {
    const pauseResp = contract.pauseContract(accounts.deployer);
    expect(pauseResp).toEqual({ ok: true, value: true });
    expect(contract.isPaused()).toEqual({ ok: true, value: true });

    const createDuringPause = contract.createHedge(
      accounts.farmer,
      "corn",
      "RegionX",
      500,
      10000,
      2000,
      1000,
      2000,
      "below"
    );
    expect(createDuringPause).toEqual({ ok: false, value: 108 });

    const unpauseResp = contract.unpauseContract(accounts.deployer);
    expect(unpauseResp).toEqual({ ok: true, value: true });
    expect(contract.isPaused()).toEqual({ ok: true, value: false });
  });

  it("should allow owner to withdraw fees", () => {
    contract.createHedge(
      accounts.farmer,
      "corn",
      "RegionX",
      500,
      10000,
      2000,
      1000,
      2000,
      "below"
    );
    expect(contract.getTotalFees()).toEqual({ ok: true, value: 50 });

    const withdrawResp = contract.withdrawFees(accounts.deployer, 50);
    expect(withdrawResp).toEqual({ ok: true, value: true });
    expect(contract.getTotalFees()).toEqual({ ok: true, value: 0 });
  });

  it("should prevent unauthorized withdrawal", () => {
    const withdrawResp = contract.withdrawFees(accounts.unauthorized, 50);
    expect(withdrawResp).toEqual({ ok: false, value: 100 });
  });
});