;; HedgingContract.clar
;; Core contract for Yield Prediction Marketplace
;; Enables creation, management, and settlement of hedging positions for agricultural yields
;; Integrates with Oracle for actual yield data, DataStorage for historical reference
;; Supports peer-to-peer hedging with staking for trust

;; Constants
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-INVALID-PARAMS u101)
(define-constant ERR-HEDGE-NOT-FOUND u102)
(define-constant ERR-ALREADY-SETTLED u103)
(define-constant ERR-SEASON-NOT-ENDED u104)
(define-constant ERR-INSUFFICIENT-STAKE u105)
(define-constant ERR-INVALID-COUNTERPARTY u106)
(define-constant ERR-HEDGE-EXPIRED u107)
(define-constant ERR-INVALID-STATE u108)
(define-constant ERR-ORACLE-FAIL u109)
(define-constant ERR-TRANSFER-FAIL u110)
(define-constant ERR-ALREADY-MATCHED u111)
(define-constant ERR-CANCELLATION-NOT-ALLOWED u112)
(define-constant ERR-FEE-CALCULATION u113)
(define-constant PLATFORM-FEE-PCT u5) ;; 0.5% fee (5/1000)
(define-constant MIN-STAKE u1000) ;; Minimum stake in micro-STX
(define-constant MAX_HEDGE_DURATION u52560) ;; ~1 year in blocks (assuming 10-min blocks)

;; Data Variables
(define-data-var contract-owner principal tx-sender)
(define-data-var hedge-counter uint u0)
(define-data-var total-fees-collected uint u0)
(define-data-var paused bool false)

;; Data Maps
(define-map Hedges
  { hedge-id: uint }
  {
    creator: principal,
    crop-type: (string-ascii 50),
    region: (string-ascii 100),
    yield-threshold: uint, ;; e.g., tons/ha * 100 for precision
    payout-amount: uint, ;; in micro-STX
    stake-amount: uint,
    counterparty: (optional principal),
    season-start: uint, ;; block height
    season-end: uint, ;; block height
    settled: bool,
    matched: bool,
    cancelled: bool,
    hedge-type: (string-ascii 20), ;; "above" or "below" threshold
    fee-paid: uint
  }
)

(define-map Stakes
  { hedge-id: uint, participant: principal }
  { amount: uint }
)

(define-map Settlements
  { hedge-id: uint }
  {
    actual-yield: uint,
    winner: principal,
    payout: uint,
    timestamp: uint
  }
)

;; Private Functions
(define-private (calculate-fee (amount uint))
  (/ (* amount PLATFORM-FEE-PCT) u1000)
)

(define-private (transfer-stx (amount uint) (from principal) (to principal))
  (try! (as-contract (stx-transfer? amount from to)))
  (ok true)
)

(define-private (refund-stake (hedge-id uint) (participant principal))
  (let
    (
      (stake (unwrap! (map-get? Stakes {hedge-id: hedge-id, participant: participant}) (err ERR-INSUFFICIENT-STAKE)))
    )
    (try! (as-contract (stx-transfer? (get amount stake) tx-sender participant)))
    (map-delete Stakes {hedge-id: hedge-id, participant: participant})
    (ok true)
  )
)

(define-private (settle-internal (hedge-id uint) (actual-yield uint))
  (let
    (
      (hedge (unwrap! (map-get? Hedges {hedge-id: hedge-id}) (err ERR-HEDGE-NOT-FOUND)))
      (creator (get creator hedge))
      (counterparty-opt (get counterparty hedge))
      (counterparty (unwrap! counterparty-opt (err ERR-INVALID-COUNTERPARTY)))
      (threshold (get yield-threshold hedge))
      (payout (get payout-amount hedge))
      (hedge-type (get hedge-type hedge))
      (is-below (is-eq hedge-type "below"))
      (condition-met (if is-below (< actual-yield threshold) (> actual-yield threshold)))
      (winner (if condition-met creator counterparty))
      (loser (if condition-met counterparty creator))
    )
    (asserts! (not (get settled hedge)) (err ERR-ALREADY-SETTLED))
    (asserts! (>= block-height (get season-end hedge)) (err ERR-SEASON-NOT-ENDED))
    
    ;; Transfer payout from loser to winner
    (try! (transfer-stx payout loser winner))
    
    ;; Refund stakes minus fees if applicable
    (try! (refund-stake hedge-id creator))
    (try! (refund-stake hedge-id counterparty))
    
    ;; Record settlement
    (map-set Settlements {hedge-id: hedge-id}
      {
        actual-yield: actual-yield,
        winner: winner,
        payout: payout,
        timestamp: block-height
      }
    )
    
    ;; Update hedge
    (map-set Hedges {hedge-id: hedge-id}
      (merge hedge {settled: true})
    )
    
    (ok winner)
  )
)

;; Public Functions
(define-public (create-hedge 
  (crop-type (string-ascii 50)) 
  (region (string-ascii 100)) 
  (yield-threshold uint) 
  (payout-amount uint)
  (stake-amount uint)
  (season-start uint)
  (season-end uint)
  (hedge-type (string-ascii 20)))
  (let
    (
      (hedge-id (+ (var-get hedge-counter) u1))
      (creator tx-sender)
      (fee (calculate-fee payout-amount))
    )
    (asserts! (not (var-get paused)) (err ERR-INVALID-STATE))
    (asserts! (>= stake-amount MIN-STAKE) (err ERR-INSUFFICIENT-STAKE))
    (asserts! (> season-end season-start) (err ERR-INVALID-PARAMS))
    (asserts! (<= (- season-end season-start) MAX_HEDGE_DURATION) (err ERR-INVALID-PARAMS))
    (asserts! (or (is-eq hedge-type "below") (is-eq hedge-type "above")) (err ERR-INVALID-PARAMS))
    (asserts! (> payout-amount u0) (err ERR-INVALID-PARAMS))
    
    ;; Transfer stake and fee
    (try! (stx-transfer? stake-amount tx-sender (as-contract tx-sender)))
    (try! (stx-transfer? fee tx-sender (as-contract tx-sender)))
    (var-set total-fees-collected (+ (var-get total-fees-collected) fee))
    
    ;; Store hedge
    (map-set Hedges {hedge-id: hedge-id}
      {
        creator: creator,
        crop-type: crop-type,
        region: region,
        yield-threshold: yield-threshold,
        payout-amount: payout-amount,
        stake-amount: stake-amount,
        counterparty: none,
        season-start: season-start,
        season-end: season-end,
        settled: false,
        matched: false,
        cancelled: false,
        hedge-type: hedge-type,
        fee-paid: fee
      }
    )
    
    ;; Store stake
    (map-set Stakes {hedge-id: hedge-id, participant: creator} {amount: stake-amount})
    
    (var-set hedge-counter hedge-id)
    (ok hedge-id)
  )
)

(define-public (match-hedge (hedge-id uint))
  (let
    (
      (hedge (unwrap! (map-get? Hedges {hedge-id: hedge-id}) (err ERR-HEDGE-NOT-FOUND)))
      (counterparty tx-sender)
      (stake-amount (get stake-amount hedge))
      (fee (calculate-fee (get payout-amount hedge)))
    )
    (asserts! (not (get matched hedge)) (err ERR-ALREADY-MATCHED))
    (asserts! (not (get settled hedge)) (err ERR-ALREADY-SETTLED))
    (asserts! (not (get cancelled hedge)) (err ERR-INVALID-STATE))
    (asserts! (not (is-eq counterparty (get creator hedge))) (err ERR-INVALID-COUNTERPARTY))
    (asserts! (< block-height (get season-start hedge)) (err ERR-HEDGE-EXPIRED))
    
    ;; Transfer stake and fee from counterparty
    (try! (stx-transfer? stake-amount tx-sender (as-contract tx-sender)))
    (try! (stx-transfer? fee tx-sender (as-contract tx-sender)))
    (var-set total-fees-collected (+ (var-get total-fees-collected) fee))
    
    ;; Update hedge
    (map-set Hedges {hedge-id: hedge-id}
      (merge hedge {
        counterparty: (some counterparty),
        matched: true,
        fee-paid: (+ (get fee-paid hedge) fee)
      })
    )
    
    ;; Store stake
    (map-set Stakes {hedge-id: hedge-id, participant: counterparty} {amount: stake-amount})
    
    (ok true)
  )
)

(define-public (settle-hedge (hedge-id uint))
  (let
    (
      (hedge (unwrap! (map-get? Hedges {hedge-id: hedge-id}) (err ERR-HEDGE-NOT-FOUND)))
      (crop-type (get crop-type hedge))
      (region (get region hedge))
      (actual-yield (unwrap! (contract-call? .OracleContract get-yield crop-type region (get season-end hedge)) (err ERR-ORACLE-FAIL)))
    )
    (asserts! (get matched hedge) (err ERR-INVALID-STATE))
    (try! (settle-internal hedge-id actual-yield))
    (ok true)
  )
)

(define-public (cancel-hedge (hedge-id uint))
  (let
    (
      (hedge (unwrap! (map-get? Hedges {hedge-id: hedge-id}) (err ERR-HEDGE-NOT-FOUND)))
      (creator (get creator hedge))
    )
    (asserts! (is-eq tx-sender creator) (err ERR-UNAUTHORIZED))
    (asserts! (not (get matched hedge)) (err ERR-CANCELLATION-NOT-ALLOWED))
    (asserts! (not (get settled hedge)) (err ERR-ALREADY-SETTLED))
    (asserts! (not (get cancelled hedge)) (err ERR-INVALID-STATE))
    
    ;; Refund stake to creator (fee is non-refundable)
    (try! (refund-stake hedge-id creator))
    
    ;; Update hedge
    (map-set Hedges {hedge-id: hedge-id}
      (merge hedge {cancelled: true})
    )
    
    (ok true)
  )
)

(define-public (pause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) (err ERR-UNAUTHORIZED))
    (var-set paused true)
    (ok true)
  )
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) (err ERR-UNAUTHORIZED))
    (var-set paused false)
    (ok true)
  )
)

(define-public (withdraw-fees (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) (err ERR-UNAUTHORIZED))
    (asserts! (<= amount (var-get total-fees-collected)) (err ERR-INSUFFICIENT-STAKE))
    (try! (as-contract (stx-transfer? amount tx-sender (var-get contract-owner))))
    (var-set total-fees-collected (- (var-get total-fees-collected) amount))
    (ok true)
  )
)

;; Read-Only Functions
(define-read-only (get-hedge-details (hedge-id uint))
  (map-get? Hedges {hedge-id: hedge-id})
)

(define-read-only (get-settlement (hedge-id uint))
  (map-get? Settlements {hedge-id: hedge-id})
)

(define-read-only (get-stake (hedge-id uint) (participant principal))
  (map-get? Stakes {hedge-id: hedge-id, participant: participant})
)

(define-read-only (get-total-fees)
  (var-get total-fees-collected)
)

(define-read-only (is-paused)
  (var-get paused)
)

(define-read-only (get-hedge-counter)
  (var-get hedge-counter)
)

(define-read-only (get-contract-owner)
  (var-get contract-owner)
)