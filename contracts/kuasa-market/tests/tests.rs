thread_local! { static RATE: std::cell::RefCell<u64> = std::cell::RefCell::new(0); }
use concordium_smart_contract_testing::*;
use concordium_std::{AccountAddress, ContractAddress, HashSha2256, Timestamp};
use kuasa_market::*;

const ARBITER: AccountAddress = AccountAddress([1; 32]);
const POOL: AccountAddress = AccountAddress([2; 32]);
const OTHER: AccountAddress = AccountAddress([3; 32]);
const CLAIMANT: AccountAddress = AccountAddress([4; 32]);
const SIGNER: Signer = Signer::with_one_key();
const DAY: u64 = 86_400_000;

fn setup() -> (Chain, ContractAddress) {
    let (chain, market, _, _) = setup_with_cover();
    (chain, market)
}

/// The market plus a real kuasa-cover instance (registered covers must run that module).
fn setup_with_cover() -> (Chain, ContractAddress, ContractAddress, ContractAddress) {
    let mut chain = Chain::builder().block_time(Timestamp::from_timestamp_millis(1_000)).build().unwrap();
    for a in [ARBITER, POOL, OTHER, CLAIMANT] {
        chain.create_account(Account::new(a, Amount::from_ccd(1_000)));
    }
    let cover_module = chain.module_deploy_v1(SIGNER, ARBITER, module_load_v1("../kuasa-cover/concordium-out/module.wasm.v1").expect("build kuasa-cover first")).unwrap().module_reference;
    let module = module_load_v1("concordium-out/module.wasm.v1").expect("build first (cargo concordium build)");
    let m = chain.module_deploy_v1(SIGNER, ARBITER, module).unwrap();
    let market = chain
        .contract_init(SIGNER, ARBITER, Energy::from(10_000), InitContractPayload {
            amount: Amount::zero(),
            mod_ref: m.module_reference,
            init_name: OwnedContractName::new_unchecked("init_kuasa_market".into()),
            param: OwnedParameter::from_serial(&InitParams { arbiter: ARBITER, min_bond: Amount::from_ccd(10), exit_delay_ms: 7 * DAY, grace_ms: DAY, unpaid_penalty: Amount::from_ccd(4), cover_module, penalty_rate: RATE.with(|r| *r.borrow()), veto_window_ms: 7 * DAY }).unwrap(),
        })
        .unwrap()
        .contract_address;
    let registry = {
        let m = chain.module_deploy_v1(SIGNER, ARBITER, module_load_v1("../kuasa-registry/concordium-out/module.wasm.v1").unwrap()).unwrap();
        chain.contract_init(SIGNER, ARBITER, Energy::from(10_000), InitContractPayload { amount: Amount::zero(), mod_ref: m.module_reference, init_name: OwnedContractName::new_unchecked("init_kuasa".into()), param: OwnedParameter::empty() }).unwrap().contract_address
    };
    let cover = chain.contract_init(SIGNER, ARBITER, Energy::from(10_000), InitContractPayload {
        amount: Amount::zero(), mod_ref: cover_module, init_name: OwnedContractName::new_unchecked("init_kuasa_cover".into()),
        param: OwnedParameter::from_serial(&kuasa_cover::InitParams { operator: AccountAddress([6; 32]), registry, auto_pay_limit: 25_000_000, objection_window_ms: 60_000, objection_bond: Amount::from_ccd(1), pool: POOL }).unwrap(),
    }).unwrap().contract_address;
    (chain, market, cover, registry)
}

fn call(chain: &mut Chain, market: ContractAddress, who: AccountAddress, name: &str, amount: Amount, param: OwnedParameter) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    chain.contract_update(SIGNER, who, Address::Account(who), Energy::from(50_000), UpdateContractPayload {
        amount,
        address: market,
        receive_name: OwnedReceiveName::new_unchecked(format!("kuasa_market.{name}")),
        message: param,
    })
}

fn reg_for(name: &str, cover: ContractAddress) -> OwnedParameter {
    OwnedParameter::from_serial(&RegisterParams { name: name.into(), cover, url: "http://localhost:4024".into(), price_bps: 8_500, evm: String::new() }).unwrap()
}

fn listed(chain: &Chain, market: ContractAddress) -> Vec<(AccountAddress, Insurer)> {
    let r = chain
        .contract_invoke(ARBITER, Address::Account(ARBITER), Energy::from(10_000), UpdateContractPayload {
            amount: Amount::zero(),
            address: market,
            receive_name: OwnedReceiveName::new_unchecked("kuasa_market.insurers".into()),
            message: OwnedParameter::empty(),
        })
        .unwrap();
    r.parse_return_value().unwrap()
}

#[test]
fn anyone_joins_with_a_bond_and_is_listed() {
    let (mut chain, market, cover, _) = setup_with_cover();
    let reg = |n: &str| reg_for(n, cover);
    assert!(call(&mut chain, market, POOL, "register", Amount::from_ccd(5), reg("Kuasa Re")).is_err(), "bond below the minimum");
    assert!(call(&mut chain, market, OTHER, "register", Amount::from_ccd(10), reg("Squatter")).is_err(), "the cover contract names another pool");
    assert!(call(&mut chain, market, POOL, "register", Amount::from_ccd(10), reg_for("Fake", ContractAddress::new(market.index, 0))).is_err(), "not the kuasa-cover module");
    call(&mut chain, market, POOL, "register", Amount::from_ccd(10), reg("Kuasa Re")).unwrap();
    let l = listed(&chain, market);
    assert_eq!(l.len(), 1);
    assert_eq!(l[0].0, POOL);
    assert_eq!(l[0].1.bond, Amount::from_ccd(10));
    // an update keeps the bond and can add to it
    call(&mut chain, market, POOL, "register", Amount::from_ccd(2), reg("Kuasa Re")).unwrap();
    assert_eq!(listed(&chain, market)[0].1.bond, Amount::from_ccd(12));
}

#[test]
fn leaving_waits_the_exit_delay_then_returns_the_bond() {
    let (mut chain, market, cover, _) = setup_with_cover();
    let reg = |n: &str| reg_for(n, cover);
    call(&mut chain, market, POOL, "register", Amount::from_ccd(10), reg("Kuasa Re")).unwrap();
    assert!(call(&mut chain, market, POOL, "withdraw", Amount::zero(), OwnedParameter::empty()).is_err(), "not leaving");
    call(&mut chain, market, POOL, "leave", Amount::zero(), OwnedParameter::empty()).unwrap();
    assert!(listed(&chain, market)[0].1.exit_at.is_some(), "listed as leaving");
    assert!(call(&mut chain, market, POOL, "register", Amount::from_ccd(1), reg("Kuasa Re")).is_err(), "no re-registering while leaving");
    assert!(call(&mut chain, market, POOL, "withdraw", Amount::zero(), OwnedParameter::empty()).is_err(), "too early");
    chain.tick_block_time(Duration::from_millis(7 * DAY)).unwrap();
    let before = chain.account_balance_available(POOL).unwrap();
    call(&mut chain, market, POOL, "withdraw", Amount::zero(), OwnedParameter::empty()).unwrap();
    assert!(chain.account_balance_available(POOL).unwrap() > before);
    assert!(listed(&chain, market).is_empty());
}

#[test]
fn only_the_arbiter_slashes_and_the_claimant_is_paid() {
    let (mut chain, market, cover, _) = setup_with_cover();
    let reg = |n: &str| reg_for(n, cover);
    call(&mut chain, market, POOL, "register", Amount::from_ccd(10), reg("Kuasa Re")).unwrap();
    let s = |amount| OwnedParameter::from_serial(&SlashParams { pool: POOL, amount, to: CLAIMANT, reason: HashSha2256([9; 32]) }).unwrap();
    assert!(call(&mut chain, market, OTHER, "slash", Amount::zero(), s(Amount::from_ccd(3))).is_err(), "not the arbiter");
    assert!(call(&mut chain, market, ARBITER, "slash", Amount::zero(), s(Amount::from_ccd(11))).is_err(), "more than the bond");
    let before = chain.account_balance_available(CLAIMANT).unwrap();
    call(&mut chain, market, ARBITER, "slash", Amount::zero(), s(Amount::from_ccd(3))).unwrap();
    assert_eq!(chain.account_balance_available(CLAIMANT).unwrap(), before + Amount::from_ccd(3));
    assert_eq!(listed(&chain, market)[0].1.bond, Amount::from_ccd(7));
}


// ---- trustless slashing, against the real kuasa-cover module -------------------------------------

use kuasa_cover::{AssessParams, ClaimKind, DecideParams, FileClaim, IssuePolicy, MandateKey, PayoutParams, PolicyKind};

const OWNER: AccountAddress = AccountAddress([5; 32]);
const OPERATOR: AccountAddress = AccountAddress([6; 32]);
const EUR: u64 = 1_000_000;

#[derive(concordium_std::Serial)]
struct RegistryIssue {
    id: HashSha2256,
    payer: AccountAddress,
    agent_registry: ContractAddress,
    agent_token: String,
    uri: String,
    max_total: u64,
    valid_until: Timestamp,
    recorders: Vec<AccountAddress>,
}

fn upd<P: concordium_std::Serial>(chain: &mut Chain, c: ContractAddress, from: AccountAddress, name: &str, p: &P, amount: Amount) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    chain.contract_update(SIGNER, from, Address::Account(from), Energy::from(100_000), UpdateContractPayload {
        amount, address: c, receive_name: OwnedReceiveName::new_unchecked(name.into()), message: OwnedParameter::from_serial(p).unwrap(),
    })
}


/// The market plus a real insurer: registry, cover contract, the insurer registered with a 10 CCD bond,
/// and an approved claim (id 0) filed by the agent payer CLAIMANT.
fn market_with_approved_claim() -> (Chain, ContractAddress, ContractAddress) {
    let (mut chain, market, cover, registry) = setup_with_cover(); // its cover: operator OPERATOR, pool POOL
    for a in [OWNER, OPERATOR] { chain.create_account(Account::new(a, Amount::from_ccd(1_000))); }
    let mandate = HashSha2256([7; 32]);
    upd(&mut chain, registry, OWNER, "kuasa.issue", &RegistryIssue { id: mandate, payer: CLAIMANT, agent_registry: ContractAddress::new(12802, 0), agent_token: "ee04".into(),
        uri: "https://k.example/m".into(), max_total: 150 * EUR, valid_until: Timestamp::from_timestamp_millis(100 * DAY), recorders: vec![] }, Amount::zero()).unwrap();
    upd(&mut chain, cover, OPERATOR, "kuasa_cover.issuePolicy", &IssuePolicy { holder: OWNER, agent_payer: CLAIMANT, agent_token: "ee04".into(), mandate: MandateKey { owner: OWNER, id: mandate },
        kind: PolicyKind::Period, limit: 100 * EUR, deductible: EUR, premium: 2 * EUR, premium_tx: HashSha2256([9; 32]), valid_until: Timestamp::from_timestamp_millis(50 * DAY) }, Amount::zero()).unwrap();
    upd(&mut chain, cover, CLAIMANT, "kuasa_cover.fileClaim", &FileClaim { policy_id: 0, kind: ClaimKind::AgentMistake, amount: 24 * EUR, evidence: HashSha2256([12; 32]), orders: vec![HashSha2256([10; 32]), HashSha2256([11; 32])] }, Amount::zero()).unwrap();
    upd(&mut chain, cover, OPERATOR, "kuasa_cover.assessClaim", &AssessParams { claim_id: 0, ok: true, reason: HashSha2256([1; 32]) }, Amount::zero()).unwrap();
    upd(&mut chain, cover, OPERATOR, "kuasa_cover.decideClaim", &DecideParams { claim_id: 0, approve: true }, Amount::zero()).unwrap();
    let reg = RegisterParams { name: "Kuasa Cover".into(), cover, url: "http://localhost:4023".into(), price_bps: 10_000, evm: String::new() };
    upd(&mut chain, market, POOL, "kuasa_market.register", &reg, Amount::from_ccd(10)).unwrap();
    (chain, market, cover)
}

#[test]
fn anyone_slashes_an_approved_claim_left_unpaid_after_the_grace_period() {
    let (mut chain, market, _cover) = market_with_approved_claim();
    let r = ClaimRef { pool: POOL, claim_id: 0 };
    assert!(upd(&mut chain, market, OTHER, "kuasa_market.slashUnpaid", &r, Amount::zero()).is_err(), "not flagged yet");
    upd(&mut chain, market, OTHER, "kuasa_market.flagUnpaid", &r, Amount::zero()).unwrap();
    assert!(upd(&mut chain, market, OTHER, "kuasa_market.slashUnpaid", &r, Amount::zero()).is_err(), "grace period still running");
    chain.tick_block_time(Duration::from_millis(DAY)).unwrap();
    let before = chain.account_balance_available(CLAIMANT).unwrap();
    upd(&mut chain, market, OTHER, "kuasa_market.slashUnpaid", &r, Amount::zero()).unwrap(); // a stranger, no arbiter
    assert_eq!(listed(&chain, market)[0].1.bond, Amount::from_ccd(6), "the penalty leaves the bond at once");
    assert!(upd(&mut chain, market, OTHER, "kuasa_market.releaseSlash", &EscrowRef { pool: POOL, cover: _cover, claim_id: 0 }, Amount::zero()).is_err(), "escrowed for the exit delay");
    chain.tick_block_time(Duration::from_millis(7 * DAY)).unwrap();
    upd(&mut chain, market, OTHER, "kuasa_market.releaseSlash", &EscrowRef { pool: POOL, cover: _cover, claim_id: 0 }, Amount::zero()).unwrap();
    assert_eq!(chain.account_balance_available(CLAIMANT).unwrap(), before + Amount::from_ccd(4), "the claimant is compensated");
    assert!(upd(&mut chain, market, OTHER, "kuasa_market.slashUnpaid", &r, Amount::zero()).is_err(), "one unpaid claim costs the bond once");
    assert!(upd(&mut chain, market, OTHER, "kuasa_market.flagUnpaid", &r, Amount::zero()).is_err(), "and cannot be flagged again");
}

#[test]
fn a_paid_claim_cannot_be_flagged_or_slashed() {
    let (mut chain, market, cover) = market_with_approved_claim();
    let r = ClaimRef { pool: POOL, claim_id: 0 };
    upd(&mut chain, market, OTHER, "kuasa_market.flagUnpaid", &r, Amount::zero()).unwrap();
    // the insurer pays inside the grace period: no slash
    upd(&mut chain, cover, OPERATOR, "kuasa_cover.recordPayout", &PayoutParams { claim_id: 0, payout_tx: HashSha2256([2; 32]), amount: 23 * EUR }, Amount::zero()).unwrap();
    chain.tick_block_time(Duration::from_millis(DAY)).unwrap();
    assert!(upd(&mut chain, market, OTHER, "kuasa_market.slashUnpaid", &r, Amount::zero()).is_err(), "paid in time");
    assert_eq!(listed(&chain, market)[0].1.bond, Amount::from_ccd(10));
    assert!(upd(&mut chain, market, OTHER, "kuasa_market.flagUnpaid", &ClaimRef { pool: POOL, claim_id: 0 }, Amount::zero()).is_err(), "a paid claim is not unpaid");
}


#[test]
fn the_panel_vetoes_a_slash_in_escrow_and_the_bond_is_restored() {
    let (mut chain, market, _cover) = market_with_approved_claim();
    let r = ClaimRef { pool: POOL, claim_id: 0 };
    upd(&mut chain, market, OTHER, "kuasa_market.flagUnpaid", &r, Amount::zero()).unwrap();
    chain.tick_block_time(Duration::from_millis(DAY)).unwrap();
    upd(&mut chain, market, OTHER, "kuasa_market.slashUnpaid", &r, Amount::zero()).unwrap();
    let e = EscrowRef { pool: POOL, cover: _cover, claim_id: 0 };
    assert!(upd(&mut chain, market, OTHER, "kuasa_market.vetoSlash", &e, Amount::zero()).is_err(), "only the arbiter vetoes");
    upd(&mut chain, market, ARBITER, "kuasa_market.vetoSlash", &e, Amount::zero()).unwrap();
    assert_eq!(listed(&chain, market)[0].1.bond, Amount::from_ccd(10), "self-dealing gains nothing");
    chain.tick_block_time(Duration::from_millis(7 * DAY)).unwrap();
    assert!(upd(&mut chain, market, OTHER, "kuasa_market.releaseSlash", &e, Amount::zero()).is_err(), "nothing left to release");
}


#[test]
fn an_escrowed_slash_survives_the_insurer_leaving_and_withdrawing() {
    let (mut chain, market, cover) = market_with_approved_claim();
    let r = ClaimRef { pool: POOL, claim_id: 0 };
    upd(&mut chain, market, OTHER, "kuasa_market.flagUnpaid", &r, Amount::zero()).unwrap();
    chain.tick_block_time(Duration::from_millis(DAY)).unwrap();
    upd(&mut chain, market, OTHER, "kuasa_market.slashUnpaid", &r, Amount::zero()).unwrap();
    // the insurer walks away with what is left of its bond
    upd(&mut chain, market, POOL, "kuasa_market.leave", &(), Amount::zero()).unwrap();
    chain.tick_block_time(Duration::from_millis(7 * DAY)).unwrap();
    upd(&mut chain, market, POOL, "kuasa_market.withdraw", &(), Amount::zero()).unwrap();
    assert!(listed(&chain, market).is_empty());
    // the claimant is still paid from escrow
    let before = chain.account_balance_available(CLAIMANT).unwrap();
    upd(&mut chain, market, OTHER, "kuasa_market.releaseSlash", &EscrowRef { pool: POOL, cover, claim_id: 0 }, Amount::zero()).unwrap();
    assert_eq!(chain.account_balance_available(CLAIMANT).unwrap(), before + Amount::from_ccd(4));
}

#[test]
fn a_slash_is_sized_to_the_unpaid_claim_and_capped_by_the_bond() {
    // 1 CCD per EUDemo: the approved claim (24 EUDemo less the 1 EUDemo deductible) is worth more than the
    // 10 CCD bond, so the whole bond goes to the claimant, not the flat 4 CCD
    RATE.with(|r| *r.borrow_mut() = 1);
    let (mut chain, market, cover) = market_with_approved_claim();
    RATE.with(|r| *r.borrow_mut() = 0);
    let r = ClaimRef { pool: POOL, claim_id: 0 };
    upd(&mut chain, market, OTHER, "kuasa_market.flagUnpaid", &r, Amount::zero()).unwrap();
    chain.tick_block_time(Duration::from_millis(DAY)).unwrap();
    let before = chain.account_balance_available(CLAIMANT).unwrap();
    upd(&mut chain, market, OTHER, "kuasa_market.slashUnpaid", &r, Amount::zero()).unwrap();
    assert_eq!(listed(&chain, market)[0].1.bond, Amount::zero(), "the payout exceeds the bond: all of it");
    chain.tick_block_time(Duration::from_millis(7 * DAY)).unwrap();
    upd(&mut chain, market, OTHER, "kuasa_market.releaseSlash", &EscrowRef { pool: POOL, cover, claim_id: 0 }, Amount::zero()).unwrap();
    assert_eq!(chain.account_balance_available(CLAIMANT).unwrap(), before + Amount::from_ccd(10));
}
