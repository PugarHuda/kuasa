//! Kuasa market: an open, bonded registry of insurers (EigenLayer-style operator registry).
//!
//! Any insurer joins by itself: its pool account calls `register` with its cover contract, URL, price
//! and a CCD bond of at least `min_bond`. Agents list insurers with `insurers` and keep those their
//! owner's mandate allows. Leaving takes `exit_delay_ms`, so an insurer cannot walk out on claims in
//! flight; after it, `withdraw` returns the bond. The market's arbiter (in production an appeals panel
//! or a Kleros court) can `slash` a bond to compensate a claimant when an approved claim stays unpaid.
#![cfg_attr(target_arch = "wasm32", no_std)]
use concordium_std::*;

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Insurer {
    pub name: String,
    pub cover: ContractAddress,
    pub url: String,
    /// The insurer's price over the shared risk model, basis points (10000 = as modelled).
    pub price_bps: u32,
    /// The EVM address it posts ERC-8004 feedback from ("" if none).
    pub evm: String,
    pub bond: Amount,
    /// Set by `leave`: the bond can be withdrawn from this time on.
    pub exit_at: Option<Timestamp>,
}

#[derive(Serialize, SchemaType)]
pub struct InitParams {
    pub arbiter: AccountAddress,
    pub min_bond: Amount,
    pub exit_delay_ms: u64,
}

#[derive(Serialize, SchemaType)]
pub struct RegisterParams {
    pub name: String,
    pub cover: ContractAddress,
    pub url: String,
    pub price_bps: u32,
    pub evm: String,
}

#[derive(Serialize, SchemaType)]
pub struct SlashParams {
    pub pool: AccountAddress,
    pub amount: Amount,
    /// Who is compensated (the claimant of the unpaid claim).
    pub to: AccountAddress,
    /// sha256 of the arbiter's reasoning (e.g. the unpaid claim and its decision).
    pub reason: HashSha2256,
}

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S: HasStateApi = StateApi> {
    arbiter: AccountAddress,
    min_bond: Amount,
    exit_delay_ms: u64,
    insurers: StateMap<AccountAddress, Insurer, S>,
}

#[derive(Serialize, SchemaType)]
pub enum Event {
    Registered { pool: AccountAddress, cover: ContractAddress, bond: Amount },
    Leaving { pool: AccountAddress, exit_at: Timestamp },
    Withdrawn { pool: AccountAddress, amount: Amount },
    Slashed { pool: AccountAddress, amount: Amount, to: AccountAddress, reason: HashSha2256 },
}

#[derive(Serialize, SchemaType, Debug, PartialEq, Eq, Reject)]
pub enum Error {
    #[from(ParseError)]
    Parse,
    #[from(LogError)]
    Log,
    Unauthorized,
    BondTooSmall,
    Leaving,
    NotLeaving,
    TooEarly,
    UnknownInsurer,
    InvalidParams,
    #[from(TransferError)]
    Transfer,
}

type CResult<T> = Result<T, Error>;

fn sender_account(ctx: &ReceiveContext) -> CResult<AccountAddress> {
    match ctx.sender() {
        Address::Account(a) => Ok(a),
        Address::Contract(_) => Err(Error::Unauthorized),
    }
}

#[init(contract = "kuasa_market", parameter = "InitParams")]
fn init(ctx: &InitContext, state_builder: &mut StateBuilder) -> InitResult<State> {
    let p: InitParams = ctx.parameter_cursor().get()?;
    Ok(State { arbiter: p.arbiter, min_bond: p.min_bond, exit_delay_ms: p.exit_delay_ms, insurers: state_builder.new_map() })
}

/// The pool account registers (or updates) itself; the attached CCD adds to its bond.
#[receive(contract = "kuasa_market", name = "register", parameter = "RegisterParams", error = "Error", mutable, payable, enable_logger)]
fn register(ctx: &ReceiveContext, host: &mut Host<State>, amount: Amount, logger: &mut Logger) -> CResult<()> {
    let pool = sender_account(ctx)?;
    let p: RegisterParams = ctx.parameter_cursor().get()?;
    ensure!(p.price_bps > 0 && p.name.len() <= 64 && p.url.len() <= 200 && p.evm.len() <= 42, Error::InvalidParams);
    let prev = host.state().insurers.get(&pool).map(|i| i.clone());
    if let Some(i) = &prev {
        ensure!(i.exit_at.is_none(), Error::Leaving);
    }
    let bond = prev.map(|i| i.bond).unwrap_or_else(Amount::zero) + amount;
    ensure!(bond >= host.state().min_bond, Error::BondTooSmall);
    let _ = host.state_mut().insurers.insert(pool, Insurer { name: p.name, cover: p.cover, url: p.url, price_bps: p.price_bps, evm: p.evm, bond, exit_at: None });
    logger.log(&Event::Registered { pool, cover: p.cover, bond })?;
    Ok(())
}

/// Starts leaving: listed as leaving at once (agents stop buying), the bond stays for `exit_delay_ms`.
#[receive(contract = "kuasa_market", name = "leave", error = "Error", mutable, enable_logger)]
fn leave(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    let pool = sender_account(ctx)?;
    let exit_at = ctx.metadata().slot_time().checked_add(Duration::from_millis(host.state().exit_delay_ms)).ok_or(Error::InvalidParams)?;
    let mut i = host.state_mut().insurers.get_mut(&pool).ok_or(Error::UnknownInsurer)?;
    ensure!(i.exit_at.is_none(), Error::Leaving);
    i.exit_at = Some(exit_at);
    drop(i);
    logger.log(&Event::Leaving { pool, exit_at })?;
    Ok(())
}

/// After the exit delay, the remaining bond goes back to the pool and the insurer is delisted.
#[receive(contract = "kuasa_market", name = "withdraw", error = "Error", mutable, enable_logger)]
fn withdraw(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    let pool = sender_account(ctx)?;
    let i = host.state().insurers.get(&pool).map(|i| i.clone()).ok_or(Error::UnknownInsurer)?;
    let exit_at = i.exit_at.ok_or(Error::NotLeaving)?;
    ensure!(ctx.metadata().slot_time() >= exit_at, Error::TooEarly);
    host.state_mut().insurers.remove(&pool);
    if i.bond > Amount::zero() {
        host.invoke_transfer(&pool, i.bond)?;
    }
    logger.log(&Event::Withdrawn { pool, amount: i.bond })?;
    Ok(())
}

/// The arbiter takes up to the whole bond to compensate the claimant of an approved, unpaid claim.
#[receive(contract = "kuasa_market", name = "slash", parameter = "SlashParams", error = "Error", mutable, enable_logger)]
fn slash(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    ensure!(sender_account(ctx)? == host.state().arbiter, Error::Unauthorized);
    let p: SlashParams = ctx.parameter_cursor().get()?;
    ensure!(p.amount > Amount::zero(), Error::InvalidParams);
    let mut i = host.state_mut().insurers.get_mut(&p.pool).ok_or(Error::UnknownInsurer)?;
    ensure!(p.amount <= i.bond, Error::InvalidParams);
    i.bond -= p.amount;
    drop(i);
    host.invoke_transfer(&p.to, p.amount)?;
    logger.log(&Event::Slashed { pool: p.pool, amount: p.amount, to: p.to, reason: p.reason })?;
    Ok(())
}

/// Every listed insurer (pool account, details). Leaving insurers are listed with their exit time.
#[receive(contract = "kuasa_market", name = "insurers", return_value = "Vec<(AccountAddress, Insurer)>", error = "Error")]
fn insurers(_ctx: &ReceiveContext, host: &Host<State>) -> CResult<Vec<(AccountAddress, Insurer)>> {
    Ok(host.state().insurers.iter().map(|(k, v)| (*k, v.clone())).collect())
}

#[derive(Serialize, SchemaType)]
pub struct Rules {
    pub arbiter: AccountAddress,
    pub min_bond: Amount,
    pub exit_delay_ms: u64,
}

/// The market's rules: who arbitrates, the minimum bond, the exit delay.
#[receive(contract = "kuasa_market", name = "rules", return_value = "Rules", error = "Error")]
fn rules(_ctx: &ReceiveContext, host: &Host<State>) -> CResult<Rules> {
    Ok(Rules { arbiter: host.state().arbiter, min_bond: host.state().min_bond, exit_delay_ms: host.state().exit_delay_ms })
}
