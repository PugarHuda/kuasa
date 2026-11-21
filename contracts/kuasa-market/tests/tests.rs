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
    let mut chain = Chain::builder().block_time(Timestamp::from_timestamp_millis(1_000)).build().unwrap();
    for a in [ARBITER, POOL, OTHER, CLAIMANT] {
        chain.create_account(Account::new(a, Amount::from_ccd(1_000)));
    }
    let module = module_load_v1("concordium-out/module.wasm.v1").expect("build first (cargo concordium build)");
    let m = chain.module_deploy_v1(SIGNER, ARBITER, module).unwrap();
    let market = chain
        .contract_init(SIGNER, ARBITER, Energy::from(10_000), InitContractPayload {
            amount: Amount::zero(),
            mod_ref: m.module_reference,
            init_name: OwnedContractName::new_unchecked("init_kuasa_market".into()),
            param: OwnedParameter::from_serial(&InitParams { arbiter: ARBITER, min_bond: Amount::from_ccd(10), exit_delay_ms: 7 * DAY }).unwrap(),
        })
        .unwrap()
        .contract_address;
    (chain, market)
}

fn call(chain: &mut Chain, market: ContractAddress, who: AccountAddress, name: &str, amount: Amount, param: OwnedParameter) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    chain.contract_update(SIGNER, who, Address::Account(who), Energy::from(50_000), UpdateContractPayload {
        amount,
        address: market,
        receive_name: OwnedReceiveName::new_unchecked(format!("kuasa_market.{name}")),
        message: param,
    })
}

fn reg(name: &str) -> OwnedParameter {
    OwnedParameter::from_serial(&RegisterParams { name: name.into(), cover: ContractAddress::new(13108, 0), url: "http://localhost:4024".into(), price_bps: 8_500, evm: String::new() }).unwrap()
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
    let (mut chain, market) = setup();
    assert!(call(&mut chain, market, POOL, "register", Amount::from_ccd(5), reg("Kuasa Re")).is_err(), "bond below the minimum");
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
    let (mut chain, market) = setup();
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
    let (mut chain, market) = setup();
    call(&mut chain, market, POOL, "register", Amount::from_ccd(10), reg("Kuasa Re")).unwrap();
    let s = |amount| OwnedParameter::from_serial(&SlashParams { pool: POOL, amount, to: CLAIMANT, reason: HashSha2256([9; 32]) }).unwrap();
    assert!(call(&mut chain, market, OTHER, "slash", Amount::zero(), s(Amount::from_ccd(3))).is_err(), "not the arbiter");
    assert!(call(&mut chain, market, ARBITER, "slash", Amount::zero(), s(Amount::from_ccd(11))).is_err(), "more than the bond");
    let before = chain.account_balance_available(CLAIMANT).unwrap();
    call(&mut chain, market, ARBITER, "slash", Amount::zero(), s(Amount::from_ccd(3))).unwrap();
    assert_eq!(chain.account_balance_available(CLAIMANT).unwrap(), before + Amount::from_ccd(3));
    assert_eq!(listed(&chain, market)[0].1.bond, Amount::from_ccd(7));
}
