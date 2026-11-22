//! Kuasa market: an open, bonded registry of insurers (EigenLayer-style operator registry).
//!
//! Any insurer joins by itself: its pool account calls `register` with its cover contract, URL, price
//! and a CCD bond of at least `min_bond`. Agents list insurers with `insurers` and keep those their
//! owner's mandate allows. Leaving takes `exit_delay_ms`, so an insurer cannot walk out on claims in
//! flight; after it, `withdraw` returns the bond. Slashing needs no arbiter for the core promise: anyone can
//! `flagUnpaid` a claim that the insurer's own cover contract shows as Approved, and if it is still not
//! Paid after `grace_ms`, anyone can `slashUnpaid`: the unpaid payout priced in CCD (`penalty_rate`, at least
//! `unpaid_penalty`, at most the bond) leaves the bond into escrow, and reaches the claimant after `veto_window_ms`.
//! The market's arbiter (in production an appeals panel or a Kleros court) can still `slash` by judgement.
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
    /// How long an approved claim may stay unpaid before anyone can slash the insurer's bond.
    pub grace_ms: u64,
    /// What one unpaid, approved claim costs the insurer's bond (paid to the claimant).
    pub unpaid_penalty: Amount,
    /// The kuasa-cover module every registered cover contract must run (its claims are the evidence).
    pub cover_module: ModuleReference,
    /// Claim-sized slashing: micro-CCD per smallest unit of the cover's token (EUDemo, 6 decimals). A slash is
    /// the unpaid payout at this rate, at least `unpaid_penalty`, at most the bond. 0 = flat `unpaid_penalty`.
    pub penalty_rate: u64,
    /// How long the arbiter can veto a slash before the claimant can be paid from escrow.
    pub veto_window_ms: u64,
    /// How much of one insurer's bond can reach claimants after the short veto window per `exit_delay_ms`;
    /// beyond it a slash waits the full exit delay, so self-dealt claims cannot pull a bond out faster than leaving.
    pub fast_release_cap: Amount,
}

#[derive(Serialize, SchemaType)]
pub struct ClaimRef {
    pub pool: AccountAddress,
    pub claim_id: u64,
}

/// An escrowed slash, named in full: it outlives the insurer's registration (release and veto never need it).
#[derive(Serialize, SchemaType)]
pub struct EscrowRef {
    pub pool: AccountAddress,
    pub cover: ContractAddress,
    pub claim_id: u64,
}

/// kuasa-cover's `claim` view, mirrored here for reading only (same wire format).
#[derive(Deserial)]
pub enum CoverClaimKind { AgentMistake, WrongItem, MerchantLoss }
#[derive(Deserial, PartialEq, Eq)]
pub enum CoverClaimStatus { Filed, Assessed { ok: bool, reason: HashSha2256 }, Approved, Rejected, Paid { payout_tx: HashSha2256 }, Fraud { disclosure: HashSha2256 } }
#[derive(Deserial)]
pub struct CoverClaim {
    pub policy_id: u64,
    pub claimant: AccountAddress,
    pub kind: CoverClaimKind,
    pub amount: u64,
    pub evidence: HashSha2256,
    pub orders: Vec<HashSha2256>,
    pub status: CoverClaimStatus,
    pub payout: u64,
}

/// kuasa-cover's `policy` view, mirrored for reading only: what the insurer can owe on a claim.
#[derive(Deserial)]
pub struct CoverMandateKey { pub owner: AccountAddress, pub id: HashSha2256 }
#[derive(Deserial)]
pub enum CoverPolicyKind { Period, Order(HashSha2256) }
#[derive(Deserial)]
pub enum CoverPolicyStatus { Active, Cancelled }
#[derive(Deserial)]
pub struct CoverPolicy {
    pub holder: AccountAddress,
    pub agent_payer: AccountAddress,
    pub agent_token: String,
    pub mandate: CoverMandateKey,
    pub kind: CoverPolicyKind,
    pub limit: u64,
    pub deductible: u64,
    pub premium: u64,
    pub premium_tx: HashSha2256,
    pub valid_from: Timestamp,
    pub valid_until: Timestamp,
    pub paid_out: u64,
    pub status: CoverPolicyStatus,
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
    grace_ms: u64,
    unpaid_penalty: Amount,
    cover_module: ModuleReference,
    penalty_rate: u64,
    veto_window_ms: u64,
    fast_release_cap: Amount,
    /// per insurer pool: (start of the current exit-delay window, amount released fast in it)
    fast_used: StateMap<AccountAddress, (Timestamp, Amount), S>,
    insurers: StateMap<AccountAddress, Insurer, S>,
    /// (pool, cover contract, claim id) -> when it was first seen Approved and unpaid
    unpaid: StateMap<(AccountAddress, ContractAddress, u64), Timestamp, S>,
    /// claims already slashed for, per cover contract (each unpaid claim costs the bond once)
    slashed_for: StateSet<(AccountAddress, ContractAddress, u64), S>,
    /// slashed amounts in escrow: (claimant, amount, release time). They leave the bond at once, reach the
    /// claimant only after veto_window_ms, and the arbiter can veto them meanwhile (an insurer approving
    /// fake claims to its own accounts cannot get its bond back faster than by leaving)
    escrow: StateMap<(AccountAddress, ContractAddress, u64), (AccountAddress, Amount, Timestamp), S>,
}

#[derive(Serialize, SchemaType)]
pub enum Event {
    Registered { pool: AccountAddress, cover: ContractAddress, bond: Amount },
    Leaving { pool: AccountAddress, exit_at: Timestamp },
    Withdrawn { pool: AccountAddress, amount: Amount },
    Slashed { pool: AccountAddress, amount: Amount, to: AccountAddress, reason: HashSha2256 },
    FlaggedUnpaid { pool: AccountAddress, claim_id: u64, at: Timestamp },
    SlashEscrowed { pool: AccountAddress, claim_id: u64, amount: Amount, to: AccountAddress, release_at: Timestamp },
    SlashVetoed { pool: AccountAddress, claim_id: u64, amount: Amount },
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
    CoverUnreadable,
    NotApprovedUnpaid,
    AlreadySlashed,
    /// The cover contract does not run the kuasa-cover module, or is not the one the insurer registered.
    WrongCover,
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
    Ok(State { arbiter: p.arbiter, min_bond: p.min_bond, exit_delay_ms: p.exit_delay_ms, grace_ms: p.grace_ms, unpaid_penalty: p.unpaid_penalty, cover_module: p.cover_module, penalty_rate: p.penalty_rate, veto_window_ms: p.veto_window_ms, fast_release_cap: p.fast_release_cap, fast_used: state_builder.new_map(),
        insurers: state_builder.new_map(), unpaid: state_builder.new_map(), slashed_for: state_builder.new_set(), escrow: state_builder.new_map() })
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
        // the cover contract is bound for good: switching it could hide unpaid claims from the market
        ensure!(i.cover == p.cover, Error::WrongCover);
    }
    // the evidence must come from the real kuasa-cover code, not a contract that reports what it likes
    let module = host.contract_module_reference(p.cover).map_err(|_| Error::WrongCover)?;
    ensure!(module == host.state().cover_module, Error::WrongCover);
    // ...and that cover contract must name this account as its pool (bondRules: objection bond, pool)
    let mut rv = host
        .invoke_contract_read_only(&p.cover, &(), EntrypointName::new_unchecked("bondRules"), Amount::zero())
        .map_err(|_| Error::WrongCover)?
        .ok_or(Error::WrongCover)?;
    let (_bond, cover_pool): (Amount, AccountAddress) = rv.get().map_err(|_| Error::WrongCover)?;
    ensure!(cover_pool == pool, Error::WrongCover);
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

/// Reads a claim from the insurer's own cover contract (the one it registered, bound for good).
fn read_policy(host: &Host<State>, cover: ContractAddress, policy_id: u64) -> CResult<CoverPolicy> {
    let mut rv = host
        .invoke_contract_read_only(&cover, &policy_id, EntrypointName::new_unchecked("policy"), Amount::zero())
        .map_err(|_| Error::CoverUnreadable)?
        .ok_or(Error::CoverUnreadable)?;
    let p: Option<CoverPolicy> = rv.get().map_err(|_| Error::CoverUnreadable)?;
    p.ok_or(Error::CoverUnreadable)
}

fn read_claim(host: &Host<State>, cover: ContractAddress, claim_id: u64) -> CResult<CoverClaim> {
    let mut rv = host
        .invoke_contract_read_only(&cover, &claim_id, EntrypointName::new_unchecked("claim"), Amount::zero())
        .map_err(|_| Error::CoverUnreadable)?
        .ok_or(Error::CoverUnreadable)?;
    let c: Option<CoverClaim> = rv.get().map_err(|_| Error::CoverUnreadable)?;
    c.ok_or(Error::NotApprovedUnpaid)
}

/// Anyone: start the clock on a claim the insurer's cover contract shows as Approved but not Paid.
#[receive(contract = "kuasa_market", name = "flagUnpaid", parameter = "ClaimRef", error = "Error", mutable, enable_logger)]
fn flag_unpaid(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    let r: ClaimRef = ctx.parameter_cursor().get()?;
    let cover = host.state().insurers.get(&r.pool).map(|i| i.cover).ok_or(Error::UnknownInsurer)?;
    let c = read_claim(host, cover, r.claim_id)?;
    ensure!(c.status == CoverClaimStatus::Approved, Error::NotApprovedUnpaid);
    ensure!(c.claimant != r.pool, Error::Unauthorized); // an insurer cannot claim its own bond back
    ensure!(!host.state().slashed_for.contains(&(r.pool, cover, r.claim_id)), Error::AlreadySlashed);
    if host.state().unpaid.get(&(r.pool, cover, r.claim_id)).is_none() {
        let at = ctx.metadata().slot_time();
        let _ = host.state_mut().unpaid.insert((r.pool, cover, r.claim_id), at);
        logger.log(&Event::FlaggedUnpaid { pool: r.pool, claim_id: r.claim_id, at })?;
    }
    Ok(())
}

/// Anyone: after the grace period, if the claim is still Approved and unpaid, the penalty goes from the
/// insurer's bond to the claimant. No arbiter: the insurer's own contract is the evidence.
#[receive(contract = "kuasa_market", name = "slashUnpaid", parameter = "ClaimRef", error = "Error", mutable, enable_logger)]
fn slash_unpaid(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    let r: ClaimRef = ctx.parameter_cursor().get()?;
    // the cover contract is bound at registration and cannot change while registered
    let cover = host.state().insurers.get(&r.pool).map(|i| i.cover).ok_or(Error::UnknownInsurer)?;
    ensure!(!host.state().slashed_for.contains(&(r.pool, cover, r.claim_id)), Error::AlreadySlashed);
    let flagged = host.state().unpaid.get(&(r.pool, cover, r.claim_id)).map(|t| *t).ok_or(Error::NotApprovedUnpaid)?;
    let due = flagged.checked_add(Duration::from_millis(host.state().grace_ms)).ok_or(Error::InvalidParams)?;
    ensure!(ctx.metadata().slot_time() >= due, Error::TooEarly);
    // read from the cover contract recorded when the claim was flagged
    let c = read_claim(host, cover, r.claim_id)?;
    ensure!(c.status == CoverClaimStatus::Approved, Error::NotApprovedUnpaid);
    ensure!(c.claimant != r.pool, Error::Unauthorized);
    // claim-sized: what the insurer owes on it (amount less the deductible, within what is left of the
    // policy limit, both read from its own cover contract), priced in CCD, never below the flat penalty
    let p = read_policy(host, cover, c.policy_id)?;
    let owed = c.amount.saturating_sub(p.deductible).min(p.limit.saturating_sub(p.paid_out));
    let sized = Amount::from_micro_ccd(owed.saturating_mul(host.state().penalty_rate));
    let penalty = if sized > host.state().unpaid_penalty { sized } else { host.state().unpaid_penalty };
    let mut i = host.state_mut().insurers.get_mut(&r.pool).ok_or(Error::UnknownInsurer)?;
    let amount = if penalty < i.bond { penalty } else { i.bond };
    ensure!(amount > Amount::zero(), Error::BondTooSmall);
    i.bond -= amount;
    drop(i);
    let _ = host.state_mut().slashed_for.insert((r.pool, cover, r.claim_id));
    host.state_mut().unpaid.remove(&(r.pool, cover, r.claim_id));
    // fast (after the veto window) within this insurer's cap per exit-delay window; the rest waits the exit delay
    let now = ctx.metadata().slot_time();
    let window = Duration::from_millis(host.state().exit_delay_ms);
    let (start, used) = host.state().fast_used.get(&r.pool).map(|x| *x).unwrap_or((now, Amount::zero()));
    let (start, used) = if now >= start.checked_add(window).ok_or(Error::InvalidParams)? { (now, Amount::zero()) } else { (start, used) };
    let fast = used + amount <= host.state().fast_release_cap;
    let _ = host.state_mut().fast_used.insert(r.pool, (start, if fast { used + amount } else { used }));
    let delay = if fast { host.state().veto_window_ms } else { host.state().exit_delay_ms };
    let release_at = now.checked_add(Duration::from_millis(delay)).ok_or(Error::InvalidParams)?;
    let _ = host.state_mut().escrow.insert((r.pool, cover, r.claim_id), (c.claimant, amount, release_at));
    logger.log(&Event::SlashEscrowed { pool: r.pool, claim_id: r.claim_id, amount, to: c.claimant, release_at })?;
    Ok(())
}

/// Anyone, after the release time: the escrowed penalty goes to the claimant.
#[receive(contract = "kuasa_market", name = "releaseSlash", parameter = "EscrowRef", error = "Error", mutable, enable_logger)]
fn release_slash(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    let r: EscrowRef = ctx.parameter_cursor().get()?;
    let (to, amount, release_at) = host.state().escrow.get(&(r.pool, r.cover, r.claim_id)).map(|e| *e).ok_or(Error::NotApprovedUnpaid)?;
    ensure!(ctx.metadata().slot_time() >= release_at, Error::TooEarly);
    host.state_mut().escrow.remove(&(r.pool, r.cover, r.claim_id));
    host.invoke_transfer(&to, amount)?;
    logger.log(&Event::Slashed { pool: r.pool, amount, to, reason: HashSha2256([0; 32]) })?;
    Ok(())
}

/// The arbiter (the 2-of-3 juror account), before release: a self-dealt or mistaken slash goes back to the bond.
#[receive(contract = "kuasa_market", name = "vetoSlash", parameter = "EscrowRef", error = "Error", mutable, enable_logger)]
fn veto_slash(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    ensure!(sender_account(ctx)? == host.state().arbiter, Error::Unauthorized);
    let r: EscrowRef = ctx.parameter_cursor().get()?;
    let (_to, amount, _release) = host.state().escrow.get(&(r.pool, r.cover, r.claim_id)).map(|e| *e).ok_or(Error::NotApprovedUnpaid)?;
    host.state_mut().escrow.remove(&(r.pool, r.cover, r.claim_id));
    // back into the bond if the insurer is still registered with that cover, else back to its pool account
    let registered = host.state().insurers.get(&r.pool).map(|i| i.cover == r.cover).unwrap_or(false);
    if registered {
        let mut i = host.state_mut().insurers.get_mut(&r.pool).ok_or(Error::UnknownInsurer)?;
        i.bond += amount;
    } else {
        host.invoke_transfer(&r.pool, amount)?;
    }
    logger.log(&Event::SlashVetoed { pool: r.pool, claim_id: r.claim_id, amount })?;
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
    pub grace_ms: u64,
    pub unpaid_penalty: Amount,
    pub penalty_rate: u64,
    pub veto_window_ms: u64,
    pub fast_release_cap: Amount,
}

/// The market's rules: who arbitrates, the minimum bond, the exit delay.
#[receive(contract = "kuasa_market", name = "rules", return_value = "Rules", error = "Error")]
fn rules(_ctx: &ReceiveContext, host: &Host<State>) -> CResult<Rules> {
    Ok(Rules { arbiter: host.state().arbiter, min_bond: host.state().min_bond, exit_delay_ms: host.state().exit_delay_ms, grace_ms: host.state().grace_ms, unpaid_penalty: host.state().unpaid_penalty, penalty_rate: host.state().penalty_rate, veto_window_ms: host.state().veto_window_ms, fast_release_cap: host.state().fast_release_cap })
}
