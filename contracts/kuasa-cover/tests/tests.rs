use concordium_smart_contract_testing::*;
use concordium_std::{AccountAddress, ContractAddress, HashSha2256, Timestamp};
use kuasa_cover::*;

const OWNER: AccountAddress = AccountAddress([1; 32]);
const PAYER: AccountAddress = AccountAddress([2; 32]);
const OPERATOR: AccountAddress = AccountAddress([3; 32]);
const STRANGER: AccountAddress = AccountAddress([4; 32]);
const MERCHANT: AccountAddress = AccountAddress([5; 32]);
const POOL: AccountAddress = AccountAddress([6; 32]);
const SIGNER: Signer = Signer::with_one_key();
const MANDATE_ID: HashSha2256 = HashSha2256([7; 32]);
const ORDER_A: HashSha2256 = HashSha2256([10; 32]);
const ORDER_B: HashSha2256 = HashSha2256([11; 32]);
const EUR: u64 = 1_000_000;
const BOND: Amount = Amount::from_ccd(1);

/// Registry params, serialised exactly like kuasa-registry's IssueParams.
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

#[derive(concordium_std::Serial)]
struct RegistryRevoke {
    id: HashSha2256,
    reason: HashSha2256,
}

struct T {
    chain: Chain,
    registry: ContractAddress,
    cover: ContractAddress,
}

fn deploy(chain: &mut Chain, path: &str, init: &str, param: OwnedParameter) -> ContractAddress {
    let module = module_load_v1(path).unwrap_or_else(|_| panic!("build {path} first (cargo concordium build)"));
    let m = chain.module_deploy_v1(SIGNER, OWNER, module).unwrap();
    chain
        .contract_init(SIGNER, OWNER, Energy::from(10_000), InitContractPayload {
            amount: Amount::zero(),
            mod_ref: m.module_reference,
            init_name: OwnedContractName::new_unchecked(init.into()),
            param,
        })
        .unwrap()
        .contract_address
}

fn setup() -> T {
    let mut chain = Chain::builder().block_time(Timestamp::from_timestamp_millis(1_000)).build().unwrap();
    for a in [OWNER, PAYER, OPERATOR, STRANGER, MERCHANT, POOL] {
        chain.create_account(Account::new(a, Amount::from_ccd(1_000)));
    }
    let registry = deploy(&mut chain, "../kuasa-registry/concordium-out/module.wasm.v1", "init_kuasa", OwnedParameter::empty());
    let cover = deploy(&mut chain, "concordium-out/module.wasm.v1", "init_kuasa_cover",
        OwnedParameter::from_serial(&InitParams { operator: OPERATOR, registry, auto_pay_limit: 25 * EUR, objection_window_ms: 60_000, objection_bond: BOND, pool: POOL }).unwrap());
    let mut t = T { chain, registry, cover };
    let issue = RegistryIssue {
        id: MANDATE_ID, payer: PAYER, agent_registry: ContractAddress::new(12802, 0), agent_token: "ee04".into(),
        uri: "https://k.example/m".into(), max_total: 150 * EUR, valid_until: Timestamp::from_timestamp_millis(1_000_000), recorders: vec![MERCHANT],
    };
    upd(&mut t.chain, registry, OWNER, "kuasa.issue", &issue).unwrap();
    t
}

fn upd<P: concordium_std::Serial>(chain: &mut Chain, c: ContractAddress, from: AccountAddress, name: &str, p: &P) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    upd_paying(chain, c, from, name, p, Amount::zero())
}

fn upd_paying<P: concordium_std::Serial>(chain: &mut Chain, c: ContractAddress, from: AccountAddress, name: &str, p: &P, amount: Amount) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    chain.contract_update(SIGNER, from, Address::Account(from), Energy::from(50_000), UpdateContractPayload {
        amount,
        address: c,
        receive_name: OwnedReceiveName::new_unchecked(name.into()),
        message: OwnedParameter::from_serial(p).unwrap(),
    })
}

fn call<P: concordium_std::Serial>(t: &mut T, from: AccountAddress, name: &str, p: &P) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    let c = t.cover;
    upd(&mut t.chain, c, from, &format!("kuasa_cover.{name}"), p)
}

fn pay<P: concordium_std::Serial>(t: &mut T, from: AccountAddress, name: &str, p: &P, amount: Amount) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    let c = t.cover;
    upd_paying(&mut t.chain, c, from, &format!("kuasa_cover.{name}"), p, amount)
}

fn view<P: concordium_std::Serial, R: concordium_std::Deserial>(t: &T, name: &str, p: &P) -> R {
    t.chain
        .contract_invoke(OWNER, Address::Account(OWNER), Energy::from(50_000), UpdateContractPayload {
            amount: Amount::zero(),
            address: t.cover,
            receive_name: OwnedReceiveName::new_unchecked(format!("kuasa_cover.{name}")),
            message: OwnedParameter::from_serial(p).unwrap(),
        })
        .unwrap()
        .parse_return_value()
        .unwrap()
}

fn policy_params() -> IssuePolicy {
    IssuePolicy {
        holder: OWNER, agent_payer: PAYER, agent_token: "ee04".into(), mandate: MandateKey { owner: OWNER, id: MANDATE_ID },
        kind: PolicyKind::Period, limit: 100 * EUR, deductible: EUR, premium: 2 * EUR, premium_tx: HashSha2256([9; 32]),
        valid_until: Timestamp::from_timestamp_millis(50_000),
    }
}

fn issue(t: &mut T) -> u64 {
    call(t, OPERATOR, "issuePolicy", &policy_params()).unwrap().parse_return_value().unwrap()
}

fn claim(orders: Vec<HashSha2256>) -> FileClaim {
    FileClaim { policy_id: 0, kind: ClaimKind::AgentMistake, amount: 24 * EUR, evidence: HashSha2256([12; 32]), orders }
}

fn cover_of(t: &T, order: Option<HashSha2256>) -> CoverView {
    view(t, "coverOf", &CoverQuery { payer: PAYER, order })
}

#[test]
fn issue_requires_active_matching_mandate() {
    let mut t = setup();
    let mut p = policy_params();
    p.holder = STRANGER;
    assert!(call(&mut t, OPERATOR, "issuePolicy", &p).is_err(), "holder must be the mandate owner");
    let mut p = policy_params();
    p.agent_payer = STRANGER;
    assert!(call(&mut t, OPERATOR, "issuePolicy", &p).is_err(), "payer must match the mandate");
    let mut p = policy_params();
    p.limit = 151 * EUR;
    assert!(call(&mut t, OPERATOR, "issuePolicy", &p).is_err(), "limit must not exceed the mandate budget");
    let mut p = policy_params();
    p.mandate.id = HashSha2256([99; 32]);
    assert!(call(&mut t, OPERATOR, "issuePolicy", &p).is_err(), "unknown mandate");

    let reg = t.registry;
    upd(&mut t.chain, reg, OWNER, "kuasa.revoke", &RegistryRevoke { id: MANDATE_ID, reason: HashSha2256([0; 32]) }).unwrap();
    assert!(call(&mut t, OPERATOR, "issuePolicy", &policy_params()).is_err(), "revoked mandate");
}

#[test]
fn period_cover_view() {
    let mut t = setup();
    assert_eq!(cover_of(&t, None), CoverView { period_remaining: 0, order_limit: 0, policy_id: None });
    let id = issue(&mut t);
    assert_eq!(cover_of(&t, None), CoverView { period_remaining: 100 * EUR, order_limit: 0, policy_id: Some(id) });
    t.chain.tick_block_time(Duration::from_millis(60_000)).unwrap();
    assert_eq!(cover_of(&t, None).period_remaining, 0, "expired cover is gone");
}

#[test]
fn order_cover_view() {
    let mut t = setup();
    let mut p = policy_params();
    p.kind = PolicyKind::Order(ORDER_A);
    p.limit = 60 * EUR;
    call(&mut t, OPERATOR, "issuePolicy", &p).unwrap();
    assert_eq!(cover_of(&t, Some(ORDER_A)).order_limit, 60 * EUR);
    assert_eq!(cover_of(&t, Some(ORDER_B)).order_limit, 0);
    assert_eq!(cover_of(&t, None).period_remaining, 0, "an order policy is not period cover");
}

#[test]
fn claim_lifecycle() {
    let mut t = setup();
    issue(&mut t);
    let cid: u64 = call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_A, ORDER_B])).unwrap().parse_return_value().unwrap();
    call(&mut t, OPERATOR, "assessClaim", &AssessParams { claim_id: cid, ok: true, reason: HashSha2256([1; 32]) }).unwrap();
    assert!(!view::<_, bool>(&t, "claimsAuthorized", &cid), "not before a human approves");
    call(&mut t, OPERATOR, "decideClaim", &DecideParams { claim_id: cid, approve: true }).unwrap();
    assert!(view::<_, bool>(&t, "claimsAuthorized", &cid));
    call(&mut t, OPERATOR, "recordPayout", &PayoutParams { claim_id: cid, payout_tx: HashSha2256([2; 32]), amount: 23 * EUR }).unwrap();
    assert!(!view::<_, bool>(&t, "claimsAuthorized", &cid), "paid claims are not authorised again");
    let c: Option<Claim> = view(&t, "claim", &cid);
    assert_eq!(c.unwrap().status, ClaimStatus::Paid { payout_tx: HashSha2256([2; 32]) });
    let p: Option<Policy> = view(&t, "policy", &0u64);
    assert_eq!(p.unwrap().paid_out, 23 * EUR);
    assert_eq!(cover_of(&t, None).period_remaining, 77 * EUR);
}

#[test]
fn approve_requires_positive_assessment() {
    let mut t = setup();
    issue(&mut t);
    let cid: u64 = call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_A])).unwrap().parse_return_value().unwrap();
    assert!(call(&mut t, OPERATOR, "decideClaim", &DecideParams { claim_id: cid, approve: true }).is_err(), "not assessed yet");
    call(&mut t, OPERATOR, "assessClaim", &AssessParams { claim_id: cid, ok: false, reason: HashSha2256([1; 32]) }).unwrap();
    assert!(call(&mut t, OPERATOR, "decideClaim", &DecideParams { claim_id: cid, approve: true }).is_err(), "negative assessment");
    call(&mut t, OPERATOR, "decideClaim", &DecideParams { claim_id: cid, approve: false }).unwrap();
    call(&mut t, OPERATOR, "markFraud", &FraudParams { claim_id: cid, disclosure: HashSha2256([3; 32]) }).unwrap();
    let c: Option<Claim> = view(&t, "claim", &cid);
    assert_eq!(c.unwrap().status, ClaimStatus::Fraud { disclosure: HashSha2256([3; 32]) });
}

#[test]
fn duplicate_order_claim_rejected() {
    let mut t = setup();
    issue(&mut t);
    call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_A])).unwrap();
    assert!(call(&mut t, OWNER, "fileClaim", &claim(vec![ORDER_A])).is_err());
    assert!(call(&mut t, PAYER, "fileClaim", &claim(vec![])).is_err(), "at least one order");
    assert!(call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_B, HashSha2256([20; 32]), HashSha2256([21; 32])])).is_err(), "at most two");
}

#[test]
fn payout_over_limit_rejected() {
    let mut t = setup();
    issue(&mut t);
    let cid: u64 = call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_A])).unwrap().parse_return_value().unwrap();
    call(&mut t, OPERATOR, "assessClaim", &AssessParams { claim_id: cid, ok: true, reason: HashSha2256([1; 32]) }).unwrap();
    call(&mut t, OPERATOR, "decideClaim", &DecideParams { claim_id: cid, approve: true }).unwrap();
    assert!(call(&mut t, OPERATOR, "recordPayout", &PayoutParams { claim_id: cid, payout_tx: HashSha2256([2; 32]), amount: 101 * EUR }).is_err());
}

#[test]
fn only_payer_or_holder_may_file_buyer_claims() {
    let mut t = setup();
    issue(&mut t);
    assert!(call(&mut t, STRANGER, "fileClaim", &claim(vec![ORDER_A])).is_err());
    call(&mut t, OWNER, "fileClaim", &claim(vec![ORDER_A])).unwrap();
    let mut m = claim(vec![ORDER_B]);
    m.kind = ClaimKind::MerchantLoss;
    call(&mut t, MERCHANT, "fileClaim", &m).unwrap();
}

#[test]
fn operator_only_entrypoints_reject_others() {
    let mut t = setup();
    assert!(call(&mut t, STRANGER, "issuePolicy", &policy_params()).is_err());
    issue(&mut t);
    let cid: u64 = call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_A])).unwrap().parse_return_value().unwrap();
    assert!(call(&mut t, STRANGER, "assessClaim", &AssessParams { claim_id: cid, ok: true, reason: HashSha2256([1; 32]) }).is_err());
    assert!(call(&mut t, PAYER, "decideClaim", &DecideParams { claim_id: cid, approve: true }).is_err());
    assert!(call(&mut t, OWNER, "cancelPolicy", &0u64).is_ok(), "holder may cancel");
    assert!(call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_B])).is_err(), "cancelled policy");
}

fn hex(b: Vec<u8>) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

/// Wire-format vectors shared with packages/core/test/cover.test.ts. Regenerate together.
fn vectors() -> Vec<(&'static str, String)> {
    use concordium_std::to_bytes;
    let mut t = setup();
    let pid = issue(&mut t);
    let cid: u64 = call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_A, ORDER_B])).unwrap().parse_return_value().unwrap();
    let raw = |t: &T, name: &str, p: Vec<u8>| -> String {
        hex(t.chain.contract_invoke(OWNER, Address::Account(OWNER), Energy::from(50_000), UpdateContractPayload {
            amount: Amount::zero(), address: t.cover, receive_name: OwnedReceiveName::new_unchecked(format!("kuasa_cover.{name}")),
            message: OwnedParameter::new_unchecked(p),
        }).unwrap().return_value)
    };
    let mut order_policy = policy_params();
    order_policy.kind = PolicyKind::Order(ORDER_A);
    vec![
        ("ISSUE_POLICY", hex(to_bytes(&policy_params()))),
        ("ISSUE_ORDER_POLICY", hex(to_bytes(&order_policy))),
        ("FILE_CLAIM", hex(to_bytes(&claim(vec![ORDER_A, ORDER_B])))),
        ("ASSESS", hex(to_bytes(&AssessParams { claim_id: 3, ok: true, reason: HashSha2256([1; 32]) }))),
        ("DECIDE", hex(to_bytes(&DecideParams { claim_id: 3, approve: false }))),
        ("PAYOUT", hex(to_bytes(&PayoutParams { claim_id: 3, payout_tx: HashSha2256([2; 32]), amount: 23 * EUR }))),
        ("FRAUD", hex(to_bytes(&FraudParams { claim_id: 3, disclosure: HashSha2256([3; 32]) }))),
        ("COVER_QUERY", hex(to_bytes(&CoverQuery { payer: PAYER, order: Some(ORDER_A) }))),
        ("COVER_VIEW", raw(&t, "coverOf", to_bytes(&CoverQuery { payer: PAYER, order: None }))),
        ("POLICY_VIEW", raw(&t, "policy", to_bytes(&pid))),
        ("CLAIM_VIEW", raw(&t, "claim", to_bytes(&cid))),
        ("SET_TERMS", hex(to_bytes(&SetTerms { policy_id: 3, terms: Terms { auto_pay_limit: 5 * EUR, objection_window_ms: 120_000, intent: Some(HashSha2256([4; 32])) } }))),
        ("TERMS_VIEW", { call(&mut t, OPERATOR, "setTerms", &SetTerms { policy_id: pid, terms: Terms { auto_pay_limit: 5 * EUR, objection_window_ms: 120_000, intent: None } }).unwrap(); raw(&t, "terms", to_bytes(&pid)) }),
        ("BOND_VIEW", { pay(&mut t, OWNER, "postBond", &PAYER, Amount::from_ccd(10)).unwrap(); raw(&t, "bondOf", to_bytes(&PAYER)) }),
    ]
}

#[test]
#[ignore]
fn print_vectors() {
    for (k, v) in vectors() { println!("{k}={v}"); }
}

/// Pins the wire format to packages/core/test/cover-vectors.json, which the TS codec tests use.
#[test]
fn wire_format_matches_typescript_codec() {
    let json = std::fs::read_to_string("../../packages/core/test/cover-vectors.json").unwrap();
    for (k, v) in vectors() {
        assert!(json.contains(&format!("\"{k}\": \"{v}\"")), "{k} drifted; run print_vectors and update the JSON + TS codec");
    }
}

#[test]
fn merchant_loss_only_from_mandate_recorders() {
    let mut t = setup();
    issue(&mut t);
    let mut m = claim(vec![ORDER_A]);
    m.kind = ClaimKind::MerchantLoss;
    assert!(call(&mut t, STRANGER, "fileClaim", &m).is_err(), "a stranger cannot squat orders via MerchantLoss");
    call(&mut t, MERCHANT, "fileClaim", &m).unwrap();
}

#[test]
fn rejected_claim_releases_its_orders() {
    let mut t = setup();
    issue(&mut t);
    let cid: u64 = call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_A])).unwrap().parse_return_value().unwrap();
    call(&mut t, OPERATOR, "decideClaim", &DecideParams { claim_id: cid, approve: false }).unwrap();
    call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_A])).unwrap();
}

#[test]
fn claims_window_closes_30_days_after_expiry() {
    let mut t = setup();
    issue(&mut t); // valid_until = 50_000 ms
    t.chain.tick_block_time(Duration::from_millis(50_000 + 29 * 86_400_000)).unwrap();
    call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_A])).unwrap();
    t.chain.tick_block_time(Duration::from_millis(2 * 86_400_000)).unwrap();
    assert!(call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_B])).is_err());
}

fn assessed_claim(t: &mut T, kind: ClaimKind, amount: u64) -> u64 {
    issue(t);
    let mut c = claim(vec![ORDER_A, ORDER_B]);
    c.kind = kind;
    c.amount = amount;
    if kind != ClaimKind::AgentMistake { c.orders = vec![ORDER_A]; }
    let from = if kind == ClaimKind::MerchantLoss { MERCHANT } else { PAYER };
    let id: u64 = call(t, from, "fileClaim", &c).unwrap().parse_return_value().unwrap();
    call(t, OPERATOR, "assessClaim", &AssessParams { claim_id: id, ok: true, reason: HashSha2256([1; 32]) }).unwrap();
    id
}

#[test]
fn rules_are_public() {
    let t = setup();
    let r: AutoRules = view(&t, "rules", &());
    assert_eq!(r, AutoRules { auto_pay_limit: 25 * EUR, objection_window_ms: 60_000 });
}

#[test]
fn auto_approve_only_after_the_window_and_within_the_limit() {
    let mut t = setup();
    let id = assessed_claim(&mut t, ClaimKind::AgentMistake, 24 * EUR);
    assert!(call(&mut t, OPERATOR, "autoApprove", &id).is_err(), "inside the objection window");
    t.chain.tick_block_time(Duration::from_millis(61_000)).unwrap();
    assert!(call(&mut t, STRANGER, "autoApprove", &id).is_err(), "operator only");
    call(&mut t, OPERATOR, "autoApprove", &id).unwrap();
    let auth: bool = view(&t, "claimsAuthorized", &id);
    assert!(auth);
}

#[test]
fn auto_approve_refuses_big_claims_and_wrong_items() {
    let mut t = setup();
    let big = assessed_claim(&mut t, ClaimKind::AgentMistake, 40 * EUR); // due 39 > 25
    let mut t2 = setup();
    let wrong = assessed_claim(&mut t2, ClaimKind::WrongItem, 5 * EUR);
    t.chain.tick_block_time(Duration::from_millis(61_000)).unwrap();
    t2.chain.tick_block_time(Duration::from_millis(61_000)).unwrap();
    assert!(call(&mut t, OPERATOR, "autoApprove", &big).is_err(), "above the auto-pay limit");
    assert!(call(&mut t2, OPERATOR, "autoApprove", &wrong).is_err(), "a wrong item needs a human");
    call(&mut t, OPERATOR, "decideClaim", &DecideParams { claim_id: big, approve: true }).unwrap(); // a human still can
}

#[test]
fn parties_can_object_inside_the_window_and_block_auto_approval() {
    let mut t = setup();
    let id = assessed_claim(&mut t, ClaimKind::AgentMistake, 24 * EUR);
    assert!(pay(&mut t, STRANGER, "objectClaim", &id, BOND).is_err(), "strangers cannot object");
    assert!(call(&mut t, MERCHANT, "objectClaim", &id).is_err(), "v3: an objection needs its bond");
    pay(&mut t, MERCHANT, "objectClaim", &id, BOND).unwrap(); // a recorder of the mandate (the merchant)
    t.chain.tick_block_time(Duration::from_millis(61_000)).unwrap();
    assert!(pay(&mut t, OWNER, "objectClaim", &id, BOND).is_err(), "window closed");
    assert!(call(&mut t, OPERATOR, "autoApprove", &id).is_err(), "objected claims need a human");
    call(&mut t, OPERATOR, "decideClaim", &DecideParams { claim_id: id, approve: true }).unwrap();
}

// ---- v3 ----------------------------------------------------------------------------------

fn ccd(t: &T, a: AccountAddress) -> Amount { t.chain.account_balance_available(a).unwrap() }

#[test]
fn operator_files_detected_duplicates_for_the_agent() {
    let mut t = setup();
    issue(&mut t);
    assert!(call(&mut t, STRANGER, "fileClaimFor", &claim(vec![ORDER_A, ORDER_B])).is_err(), "operator only");
    let mut one = claim(vec![ORDER_A]);
    assert!(call(&mut t, OPERATOR, "fileClaimFor", &one).is_err(), "a duplicate needs two orders");
    one.kind = ClaimKind::WrongItem;
    one.orders = vec![ORDER_A, ORDER_B];
    assert!(call(&mut t, OPERATOR, "fileClaimFor", &one).is_err(), "only agent mistakes");
    let id: u64 = call(&mut t, OPERATOR, "fileClaimFor", &claim(vec![ORDER_A, ORDER_B])).unwrap().parse_return_value().unwrap();
    let c: Option<Claim> = view(&t, "claim", &id);
    assert_eq!(c.unwrap().claimant, PAYER, "recorded for the agent payer");
    assert!(call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_A, ORDER_B])).is_err(), "the orders are taken");
}

#[test]
fn policy_terms_only_tighten_the_rules() {
    let mut t = setup();
    issue(&mut t);
    let loose = Terms { auto_pay_limit: 100 * EUR, objection_window_ms: 1_000, intent: Some(HashSha2256([5; 32])) };
    assert!(call(&mut t, STRANGER, "setTerms", &SetTerms { policy_id: 0, terms: loose }).is_err(), "operator only");
    call(&mut t, OPERATOR, "setTerms", &SetTerms { policy_id: 0, terms: loose }).unwrap();
    assert!(call(&mut t, OPERATOR, "setTerms", &SetTerms { policy_id: 0, terms: loose }).is_err(), "set once");
    let got: Option<Terms> = view(&t, "terms", &0u64);
    assert_eq!(got, Some(loose));
    // looser terms do not loosen anything: 39 due > 25 published limit, window stays 60 s
    let mut c = claim(vec![ORDER_A, ORDER_B]);
    c.amount = 40 * EUR;
    let id: u64 = call(&mut t, PAYER, "fileClaim", &c).unwrap().parse_return_value().unwrap();
    call(&mut t, OPERATOR, "assessClaim", &AssessParams { claim_id: id, ok: true, reason: HashSha2256([1; 32]) }).unwrap();
    t.chain.tick_block_time(Duration::from_millis(30_000)).unwrap();
    assert!(call(&mut t, OPERATOR, "autoApprove", &id).is_err(), "still inside the published window");
    t.chain.tick_block_time(Duration::from_millis(31_000)).unwrap();
    assert!(call(&mut t, OPERATOR, "autoApprove", &id).is_err(), "above the published limit");
}

#[test]
fn stricter_terms_apply() {
    let mut t = setup();
    issue(&mut t);
    call(&mut t, OPERATOR, "setTerms", &SetTerms { policy_id: 0, terms: Terms { auto_pay_limit: 5 * EUR, objection_window_ms: 120_000, intent: None } }).unwrap();
    let mut c = claim(vec![ORDER_A, ORDER_B]);
    c.amount = 10 * EUR; // due 9: fine under the published 25, not under this policy's 5
    let id: u64 = call(&mut t, PAYER, "fileClaim", &c).unwrap().parse_return_value().unwrap();
    call(&mut t, OPERATOR, "assessClaim", &AssessParams { claim_id: id, ok: true, reason: HashSha2256([1; 32]) }).unwrap();
    t.chain.tick_block_time(Duration::from_millis(121_000)).unwrap();
    assert!(call(&mut t, OPERATOR, "autoApprove", &id).is_err(), "the policy's own limit");
}

#[test]
fn objection_bonds_return_when_upheld_and_go_to_the_operator_when_not() {
    let mut t = setup();
    let id = assessed_claim(&mut t, ClaimKind::AgentMistake, 24 * EUR);
    let before = ccd(&t, MERCHANT);
    pay(&mut t, MERCHANT, "objectClaim", &id, BOND).unwrap();
    call(&mut t, OPERATOR, "decideClaim", &DecideParams { claim_id: id, approve: false }).unwrap();
    assert!(before - ccd(&t, MERCHANT) < Amount::from_micro_ccd(100_000), "bond back (only fees spent)");

    let mut t2 = setup();
    let id2 = assessed_claim(&mut t2, ClaimKind::AgentMistake, 24 * EUR);
    pay(&mut t2, MERCHANT, "objectClaim", &id2, BOND).unwrap();
    let pool = ccd(&t2, POOL);
    call(&mut t2, OPERATOR, "decideClaim", &DecideParams { claim_id: id2, approve: true }).unwrap();
    assert_eq!(ccd(&t2, POOL), pool + BOND, "forfeited to the pool, not the operator");
}

#[test]
fn operator_bond_is_slashed_on_proven_fraud_and_locked_while_claims_are_open() {
    let mut t = setup();
    issue(&mut t);
    pay(&mut t, OWNER, "postBond", &PAYER, Amount::from_ccd(10)).unwrap();
    assert!(pay(&mut t, STRANGER, "postBond", &PAYER, Amount::from_ccd(1)).is_err(), "strangers cannot bond (or grief) an agent");
    let b: Option<Bond> = view(&t, "bondOf", &PAYER);
    assert_eq!(b, Some(Bond { poster: OWNER, amount: Amount::from_ccd(10) }));
    let id: u64 = call(&mut t, PAYER, "fileClaim", &claim(vec![ORDER_A, ORDER_B])).unwrap().parse_return_value().unwrap();
    assert!(call(&mut t, OWNER, "withdrawBond", &PAYER).is_err(), "a claim is open");
    call(&mut t, OPERATOR, "decideClaim", &DecideParams { claim_id: id, approve: false }).unwrap();
    assert!(call(&mut t, OWNER, "withdrawBond", &PAYER).is_err(), "rejected recently: may still be fraud");
    let pool = ccd(&t, POOL);
    call(&mut t, OPERATOR, "markFraud", &FraudParams { claim_id: id, disclosure: HashSha2256([6; 32]) }).unwrap();
    assert_eq!(ccd(&t, POOL), pool + Amount::from_ccd(10), "slashed into the pool");
    let gone: Option<Bond> = view(&t, "bondOf", &PAYER);
    assert_eq!(gone, None);
}

#[test]
fn a_claim_the_operator_filed_never_slashes_the_bond() {
    let mut t = setup();
    issue(&mut t);
    pay(&mut t, OWNER, "postBond", &PAYER, Amount::from_ccd(10)).unwrap();
    let id: u64 = call(&mut t, OPERATOR, "fileClaimFor", &claim(vec![ORDER_A, ORDER_B])).unwrap().parse_return_value().unwrap();
    call(&mut t, OPERATOR, "decideClaim", &DecideParams { claim_id: id, approve: false }).unwrap();
    call(&mut t, OPERATOR, "markFraud", &FraudParams { claim_id: id, disclosure: HashSha2256([6; 32]) }).unwrap();
    let b: Option<Bond> = view(&t, "bondOf", &PAYER);
    assert!(b.is_some(), "not the agent's filing: no slash");
}

#[test]
fn bond_can_be_withdrawn_when_nothing_is_open() {
    let mut t = setup();
    issue(&mut t);
    pay(&mut t, OWNER, "postBond", &PAYER, Amount::from_ccd(10)).unwrap();
    assert!(call(&mut t, STRANGER, "withdrawBond", &PAYER).is_err(), "poster only");
    assert!(call(&mut t, OWNER, "withdrawBond", &PAYER).is_err(), "locked while it backs live cover");
    t.chain.tick_block_time(Duration::from_millis(50_000)).unwrap(); // the policy ends ...
    assert!(call(&mut t, OWNER, "withdrawBond", &PAYER).is_err(), "... but claims can still be filed for 30 days");
    call(&mut t, OWNER, "cancelPolicy", &0u64).unwrap();
    assert!(call(&mut t, OWNER, "withdrawBond", &PAYER).is_err(), "cancelling does not shorten the lock");
    t.chain.tick_block_time(Duration::from_millis(30 * 86_400_000)).unwrap(); // claims window over
    let before = ccd(&t, OWNER);
    call(&mut t, OWNER, "withdrawBond", &PAYER).unwrap();
    assert!(ccd(&t, OWNER) + Amount::from_micro_ccd(100_000) > before + Amount::from_ccd(10));
}
