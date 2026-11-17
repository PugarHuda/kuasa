use concordium_smart_contract_testing::*;
use concordium_std::{AccountAddress, ContractAddress, HashSha2256, Timestamp};
use kuasa_registry::*;

const OWNER: AccountAddress = AccountAddress([1; 32]);
const PAYER: AccountAddress = AccountAddress([2; 32]);
const RECORDER: AccountAddress = AccountAddress([3; 32]);
const STRANGER: AccountAddress = AccountAddress([4; 32]);
const SIGNER: Signer = Signer::with_one_key();
const ID: HashSha2256 = HashSha2256([7; 32]);

fn setup() -> (Chain, ContractAddress) {
    let mut chain = Chain::builder().block_time(Timestamp::from_timestamp_millis(1_000)).build().unwrap();
    for a in [OWNER, PAYER, RECORDER, STRANGER] {
        chain.create_account(Account::new(a, Amount::from_ccd(1_000)));
    }
    let module = module_load_v1("concordium-out/module.wasm.v1").expect("run `cargo concordium build --out concordium-out/module.wasm.v1` first");
    let deployed = chain.module_deploy_v1(SIGNER, OWNER, module).unwrap();
    let init = chain
        .contract_init(SIGNER, OWNER, Energy::from(10_000), InitContractPayload {
            amount: Amount::zero(),
            mod_ref: deployed.module_reference,
            init_name: OwnedContractName::new_unchecked("init_kuasa".into()),
            param: OwnedParameter::empty(),
        })
        .unwrap();
    (chain, init.contract_address)
}

fn call<P: concordium_std::Serial>(chain: &mut Chain, c: ContractAddress, from: AccountAddress, name: &str, p: &P) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    chain.contract_update(SIGNER, from, Address::Account(from), Energy::from(20_000), UpdateContractPayload {
        amount: Amount::zero(),
        address: c,
        receive_name: OwnedReceiveName::new_unchecked(format!("kuasa.{name}")),
        message: OwnedParameter::from_serial(p).unwrap(),
    })
}

fn view(chain: &Chain, c: ContractAddress) -> Option<MandateEntry> {
    let r = chain
        .contract_invoke(OWNER, Address::Account(OWNER), Energy::from(10_000), UpdateContractPayload {
            amount: Amount::zero(),
            address: c,
            receive_name: OwnedReceiveName::new_unchecked("kuasa.view".into()),
            message: OwnedParameter::from_serial(&ID).unwrap(),
        })
        .unwrap();
    r.parse_return_value().unwrap()
}

fn issue_params() -> IssueParams {
    IssueParams {
        id: ID,
        payer: PAYER,
        agent_registry: ContractAddress::new(12802, 0),
        agent_token: "7".into(),
        uri: "https://kuasa.example/m/7".into(),
        max_total: 100,
        valid_until: Timestamp::from_timestamp_millis(10_000),
        recorders: vec![RECORDER],
    }
}

fn receipt(amount: u64) -> ReceiptParams {
    ReceiptParams { id: ID, order: HashSha2256([9; 32]), payment_tx: HashSha2256([8; 32]), amount }
}

#[test]
fn full_lifecycle() {
    let (mut chain, c) = setup();
    call(&mut chain, c, OWNER, "issue", &issue_params()).unwrap();
    assert!(call(&mut chain, c, OWNER, "issue", &issue_params()).is_err(), "duplicate id rejected");

    let m = view(&chain, c).unwrap();
    assert_eq!((m.owner, m.payer, m.spent, m.revoked), (OWNER, PAYER, 0, false));

    // only recorders may record spend; budget is enforced on-chain
    assert!(call(&mut chain, c, STRANGER, "recordReceipt", &receipt(10)).is_err());
    call(&mut chain, c, RECORDER, "recordReceipt", &receipt(60)).unwrap();
    assert!(call(&mut chain, c, RECORDER, "recordReceipt", &receipt(41)).is_err(), "over budget");
    call(&mut chain, c, RECORDER, "recordReceipt", &receipt(40)).unwrap();
    let m = view(&chain, c).unwrap();
    assert_eq!((m.spent, m.receipts), (100, 2));

    // anyone may report; only the owner may revoke; revocation stops spending
    call(&mut chain, c, STRANGER, "reportIncident", &IncidentParams { id: ID, evidence: HashSha2256([5; 32]) }).unwrap();
    let rv = RevokeParams { id: ID, reason: HashSha2256([0; 32]) };
    assert!(call(&mut chain, c, STRANGER, "revoke", &rv).is_err());
    call(&mut chain, c, OWNER, "revoke", &rv).unwrap();
    let m = view(&chain, c).unwrap();
    assert!(m.revoked);
    assert_eq!(m.incidents, 1);
}

#[test]
fn revoked_and_expired_mandates_cannot_spend() {
    let (mut chain, c) = setup();
    call(&mut chain, c, OWNER, "issue", &issue_params()).unwrap();
    call(&mut chain, c, OWNER, "revoke", &RevokeParams { id: ID, reason: HashSha2256([0; 32]) }).unwrap();
    assert!(call(&mut chain, c, RECORDER, "recordReceipt", &receipt(1)).is_err());

    let (mut chain, c) = setup();
    call(&mut chain, c, OWNER, "issue", &issue_params()).unwrap();
    chain.tick_block_time(Duration::from_millis(20_000)).unwrap();
    assert!(call(&mut chain, c, RECORDER, "recordReceipt", &receipt(1)).is_err());
}

#[test]
fn rejects_already_expired_issue() {
    let (mut chain, c) = setup();
    let mut p = issue_params();
    p.valid_until = Timestamp::from_timestamp_millis(500);
    assert!(call(&mut chain, c, OWNER, "issue", &p).is_err());
}

/// Pins the wire format the TypeScript codec (packages/core/src/registry.ts) produces.
/// If this fails, update the TS codec and regenerate these constants together.
#[test]
fn wire_format_matches_typescript_codec() {
    use concordium_std::to_bytes;
    const TS_ISSUE: &str = "070707070707070707070707070707070707070707070707070707070707070702020202020202020202020202020202020202020202020202020202020202020232000000000000000000000000000001000000371900000068747470733a2f2f6b756173612e6578616d706c652f6d2f3764000000000000001027000000000000010000000303030303030303030303030303030303030303030303030303030303030303";
    const TS_VIEW: &str = "01010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020232000000000000000000000000000001000000371900000068747470733a2f2f6b756173612e6578616d706c652f6d2f376400000000000000000000000000000010270000000000000001000000030303030303030303030303030303030303030303030303030303030303030300000000000000000000000000000000";
    let hex = |b: Vec<u8>| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    assert_eq!(hex(to_bytes(&issue_params())), TS_ISSUE);

    let (mut chain, c) = setup();
    call(&mut chain, c, OWNER, "issue", &issue_params()).unwrap();
    let raw = chain
        .contract_invoke(OWNER, Address::Account(OWNER), Energy::from(10_000), UpdateContractPayload {
            amount: Amount::zero(),
            address: c,
            receive_name: OwnedReceiveName::new_unchecked("kuasa.view".into()),
            message: OwnedParameter::from_serial(&ID).unwrap(),
        })
        .unwrap()
        .return_value;
    assert_eq!(hex(raw), TS_VIEW);
}
