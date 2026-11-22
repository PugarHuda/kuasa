use concordium_cis2::*;
use concordium_smart_contract_testing::*;
use concordium_std::{AccountAddress, ContractAddress, HashSha2256, Timestamp};
use kuasa_certificate::*;
use kuasa_cover::{IssuePolicy, MandateKey, PolicyKind};

const OWNER: AccountAddress = AccountAddress([5; 32]);
const OPERATOR: AccountAddress = AccountAddress([6; 32]);
const PAYER: AccountAddress = AccountAddress([4; 32]);
const OTHER: AccountAddress = AccountAddress([3; 32]);
const POOL: AccountAddress = AccountAddress([2; 32]);
const SIGNER: Signer = Signer::with_one_key();
const DAY: u64 = 86_400_000;
const EUR: u64 = 1_000_000;

#[derive(concordium_std::Serial)]
struct RegistryIssue { id: HashSha2256, payer: AccountAddress, agent_registry: ContractAddress, agent_token: String, uri: String, max_total: u64, valid_until: Timestamp, recorders: Vec<AccountAddress> }

fn upd<P: concordium_std::Serial>(chain: &mut Chain, c: ContractAddress, from: AccountAddress, name: &str, p: &P) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    chain.contract_update(SIGNER, from, Address::Account(from), Energy::from(100_000), UpdateContractPayload {
        amount: Amount::zero(), address: c, receive_name: OwnedReceiveName::new_unchecked(name.into()), message: OwnedParameter::from_serial(p).unwrap(),
    })
}

/// A registry, a cover contract with one live period policy (id 0) for PAYER, and the certificate contract.
fn setup() -> (Chain, ContractAddress, ContractAddress) {
    let mut chain = Chain::builder().block_time(Timestamp::from_timestamp_millis(1_000)).build().unwrap();
    for a in [OWNER, OPERATOR, PAYER, OTHER, POOL] { chain.create_account(Account::new(a, Amount::from_ccd(1_000))); }
    let init = |chain: &mut Chain, path: &str, name: &str, param: OwnedParameter| {
        let m = chain.module_deploy_v1(SIGNER, OWNER, module_load_v1(path).expect("build the modules first")).unwrap().module_reference;
        chain.contract_init(SIGNER, OWNER, Energy::from(10_000), InitContractPayload { amount: Amount::zero(), mod_ref: m, init_name: OwnedContractName::new_unchecked(name.into()), param }).unwrap().contract_address
    };
    let registry = init(&mut chain, "../kuasa-registry/concordium-out/module.wasm.v1", "init_kuasa", OwnedParameter::empty());
    let cover = init(&mut chain, "../kuasa-cover/concordium-out/module.wasm.v1", "init_kuasa_cover", OwnedParameter::from_serial(&kuasa_cover::InitParams { operator: OPERATOR, registry, auto_pay_limit: 25_000_000, objection_window_ms: 60_000, objection_bond: Amount::from_ccd(1), pool: POOL }).unwrap());
    let cert = init(&mut chain, "concordium-out/module.wasm.v1", "init_kuasa_certificate", OwnedParameter::from_serial(&InitParams { cover, metadata_url: "https://kuasa-explorer.vercel.app/certificate.json".into() }).unwrap());
    let mandate = HashSha2256([7; 32]);
    upd(&mut chain, registry, OWNER, "kuasa.issue", &RegistryIssue { id: mandate, payer: PAYER, agent_registry: ContractAddress::new(12802, 0), agent_token: "ee04".into(), uri: "https://k.example/m".into(), max_total: 150 * EUR, valid_until: Timestamp::from_timestamp_millis(100 * DAY), recorders: vec![] }).unwrap();
    upd(&mut chain, cover, OPERATOR, "kuasa_cover.issuePolicy", &IssuePolicy { holder: OWNER, agent_payer: PAYER, agent_token: "ee04".into(), mandate: MandateKey { owner: OWNER, id: mandate },
        kind: PolicyKind::Period, limit: 100 * EUR, deductible: EUR, premium: 2 * EUR, premium_tx: HashSha2256([9; 32]), valid_until: Timestamp::from_timestamp_millis(50 * DAY) }).unwrap();
    (chain, cover, cert)
}

fn balance(chain: &Chain, cert: ContractAddress, who: AccountAddress, token: u64) -> u8 {
    let q = BalanceOfQueryParams { queries: vec![BalanceOfQuery { token_id: TokenIdU64(token), address: Address::Account(who) }] };
    let r = chain.contract_invoke(OTHER, Address::Account(OTHER), Energy::from(50_000), UpdateContractPayload {
        amount: Amount::zero(), address: cert, receive_name: OwnedReceiveName::new_unchecked("kuasa_certificate.balanceOf".into()), message: OwnedParameter::from_serial(&q).unwrap(),
    }).unwrap();
    let out: BalanceOfQueryResponse<TokenAmountU8> = r.parse_return_value().unwrap();
    out.0[0].0
}

#[test]
fn the_insured_agent_holds_its_certificate_while_the_policy_is_live() {
    let (mut chain, cover, cert) = setup();
    assert_eq!(balance(&chain, cert, PAYER, 0), 1, "the agent payer holds certificate 0");
    assert_eq!(balance(&chain, cert, OTHER, 0), 0, "nobody else does");
    assert_eq!(balance(&chain, cert, PAYER, 1), 0, "there is no policy 1");
    upd(&mut chain, cover, OWNER, "kuasa_cover.cancelPolicy", &0u64).unwrap();
    assert_eq!(balance(&chain, cert, PAYER, 0), 0, "a cancelled policy shows 0 at once, nothing burned by hand");
}

#[test]
fn a_certificate_lapses_with_its_policy_and_cannot_be_transferred() {
    let (mut chain, _cover, cert) = setup();
    let t = TransferParams::<TokenIdU64, TokenAmountU8>(vec![concordium_cis2::Transfer { token_id: TokenIdU64(0), amount: TokenAmountU8(1), from: Address::Account(PAYER), to: Receiver::Account(OTHER), data: AdditionalData::empty() }]);
    assert!(upd(&mut chain, cert, PAYER, "kuasa_certificate.transfer", &t).is_err(), "a certificate follows its policy");
    chain.tick_block_time(Duration::from_millis(60 * DAY)).unwrap();
    assert_eq!(balance(&chain, cert, PAYER, 0), 0, "expired with the policy");
}

#[test]
fn announce_logs_one_mint_for_a_live_policy_and_retire_one_burn_after_it_ends() {
    let (mut chain, cover, cert) = setup();
    let r = upd(&mut chain, cert, OTHER, "kuasa_certificate.announce", &TokenIdU64(0)).unwrap();
    assert!(r.events().count() >= 1, "the mint is logged");
    assert!(upd(&mut chain, cert, OTHER, "kuasa_certificate.announce", &TokenIdU64(0)).is_err(), "once");
    assert!(upd(&mut chain, cert, OTHER, "kuasa_certificate.retire", &TokenIdU64(0)).is_err(), "not while the policy is live");
    upd(&mut chain, cover, OWNER, "kuasa_cover.cancelPolicy", &0u64).unwrap();
    upd(&mut chain, cert, OTHER, "kuasa_certificate.retire", &TokenIdU64(0)).unwrap();
    assert!(upd(&mut chain, cert, OTHER, "kuasa_certificate.announce", &TokenIdU64(0)).is_err(), "a cancelled policy cannot be announced again");
}
