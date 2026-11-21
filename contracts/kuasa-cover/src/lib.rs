//! # Kuasa Cover
//!
//! Insurance books for AI agent commerce. Policies cover an agent that shops under a Kuasa
//! mandate; claims are filed against on-chain evidence and paid only after a human approves.
//!
//! The pool itself is not held here: smart contracts cannot hold Protocol-Level Tokens yet, so
//! the EUDemo pool is an insurer treasury account and this contract keeps the books. Once
//! Protocol-Level Locks: Enhanced ship, the pool moves into a lock whose release is authorised
//! by `claimsAuthorized` below.
//!
//! v3 adds: claims the operator files on the agent's behalf (parametric duplicate detection),
//! per-policy terms that can only tighten the published rules, bonded objections (CCD), and an
//! agent operator bond that is slashed when fraud is proven. Policy and Claim layouts are unchanged.
#![cfg_attr(target_arch = "wasm32", no_std)]

use concordium_std::*;

/// Mirror of the kuasa registry key (same layout; that crate is not linked in on purpose).
#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub struct MandateKey {
    pub owner: AccountAddress,
    pub id: HashSha2256,
}

/// Mirror of the kuasa registry `MandateEntry` (field order must match exactly).
#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct MandateEntry {
    pub owner: AccountAddress,
    pub payer: AccountAddress,
    pub agent_registry: ContractAddress,
    pub agent_token: String,
    pub uri: String,
    pub max_total: u64,
    pub spent: u64,
    pub valid_until: Timestamp,
    pub revoked: bool,
    pub recorders: Vec<AccountAddress>,
    pub receipts: u64,
    pub incidents: u64,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct InitParams {
    pub operator: AccountAddress,
    pub registry: ContractAddress,
    /// v2: claims whose amount above the deductible is at most this may be approved automatically.
    pub auto_pay_limit: u64,
    /// v2: how long after the assessment parties can object before an automatic approval.
    pub objection_window_ms: u64,
    /// v3: CCD an objector must lock with an objection (returned if the claim is rejected).
    pub objection_bond: Amount,
}

/// v3: bond rules (separate view, so the v2 `rules` view keeps its layout).
#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub struct BondRules {
    pub objection_bond: Amount,
}

/// v3: per-policy terms. They can only tighten the published rules (lower limit, longer window).
#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Terms {
    pub auto_pay_limit: u64,
    pub objection_window_ms: u64,
    /// sha256 of the owner-signed AP2 intent the policy was bought under, if any.
    pub intent: Option<HashSha2256>,
}

#[derive(Serialize, SchemaType, Clone, Copy, Debug)]
pub struct SetTerms {
    pub policy_id: u64,
    pub terms: Terms,
}

/// v3: a bond posted for an agent payer by its operator (the poster).
#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Bond {
    pub poster: AccountAddress,
    pub amount: Amount,
}

/// The published automation rules, enforced by `autoApprove` and `objectClaim`.
#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub struct AutoRules {
    pub auto_pay_limit: u64,
    pub objection_window_ms: u64,
}

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PolicyKind {
    Period,
    Order(HashSha2256),
}

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PolicyStatus {
    Active,
    Cancelled,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Policy {
    pub holder: AccountAddress,
    pub agent_payer: AccountAddress,
    pub agent_token: String,
    pub mandate: MandateKey,
    pub kind: PolicyKind,
    pub limit: u64,
    pub deductible: u64,
    pub premium: u64,
    pub premium_tx: HashSha2256,
    pub valid_from: Timestamp,
    pub valid_until: Timestamp,
    pub paid_out: u64,
    pub status: PolicyStatus,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct IssuePolicy {
    pub holder: AccountAddress,
    pub agent_payer: AccountAddress,
    pub agent_token: String,
    pub mandate: MandateKey,
    pub kind: PolicyKind,
    pub limit: u64,
    pub deductible: u64,
    pub premium: u64,
    pub premium_tx: HashSha2256,
    pub valid_until: Timestamp,
}

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClaimKind {
    AgentMistake,
    WrongItem,
    MerchantLoss,
}

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClaimStatus {
    Filed,
    Assessed { ok: bool, reason: HashSha2256 },
    Approved,
    Rejected,
    Paid { payout_tx: HashSha2256 },
    Fraud { disclosure: HashSha2256 },
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Claim {
    pub policy_id: u64,
    pub claimant: AccountAddress,
    pub kind: ClaimKind,
    pub amount: u64,
    pub evidence: HashSha2256,
    pub orders: Vec<HashSha2256>,
    pub status: ClaimStatus,
    pub payout: u64,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct FileClaim {
    pub policy_id: u64,
    pub kind: ClaimKind,
    pub amount: u64,
    pub evidence: HashSha2256,
    /// Order hashes from the mandate registry receipts this claim rests on (1 or 2).
    pub orders: Vec<HashSha2256>,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct AssessParams {
    pub claim_id: u64,
    pub ok: bool,
    pub reason: HashSha2256,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct DecideParams {
    pub claim_id: u64,
    pub approve: bool,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct PayoutParams {
    pub claim_id: u64,
    pub payout_tx: HashSha2256,
    pub amount: u64,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct FraudParams {
    pub claim_id: u64,
    pub disclosure: HashSha2256,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct CoverQuery {
    pub payer: AccountAddress,
    pub order: Option<HashSha2256>,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct CoverView {
    pub period_remaining: u64,
    pub order_limit: u64,
    pub policy_id: Option<u64>,
}

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    operator: AccountAddress,
    registry: ContractAddress,
    next_policy: u64,
    next_claim: u64,
    policies: StateMap<u64, Policy, S>,
    claims: StateMap<u64, Claim, S>,
    by_payer: StateMap<AccountAddress, Vec<u64>, S>,
    claimed_orders: StateSet<(u64, HashSha2256), S>,
    rules: AutoRules,
    assessed_at: StateMap<u64, Timestamp, S>,
    objected: StateSet<u64, S>,
    bond_rules: BondRules,
    terms: StateMap<u64, Terms, S>,
    /// claim -> objectors and the CCD each locked
    objection_bonds: StateMap<u64, Vec<(AccountAddress, Amount)>, S>,
    /// agent payer -> operator bond
    bonds: StateMap<AccountAddress, Bond, S>,
    /// claim -> when it was rejected (a bond cannot leave within 30 days of a rejection)
    rejected_at: StateMap<u64, Timestamp, S>,
}

#[derive(Debug, PartialEq, Eq, Reject, Serialize, SchemaType)]
pub enum Error {
    #[from(ParseError)]
    Parse,
    OnlyAccount,
    Unauthorized,
    NotFound,
    InvalidParams,
    MandateInvalid,
    PolicyInactive,
    OrderAlreadyClaimed,
    WrongStatus,
    OverLimit,
    RegistryCall,
    LogFull,
    LogMalformed,
    BondTooSmall,
    BondLocked,
    TransferFailed,
}

impl From<LogError> for Error {
    fn from(e: LogError) -> Self {
        match e {
            LogError::Full => Error::LogFull,
            LogError::Malformed => Error::LogMalformed,
        }
    }
}

pub type CResult<T> = Result<T, Error>;

#[init(contract = "kuasa_cover", parameter = "InitParams")]
fn init(ctx: &InitContext, state_builder: &mut StateBuilder) -> InitResult<State> {
    let p: InitParams = ctx.parameter_cursor().get()?;
    Ok(State {
        operator: p.operator,
        registry: p.registry,
        next_policy: 0,
        next_claim: 0,
        policies: state_builder.new_map(),
        claims: state_builder.new_map(),
        by_payer: state_builder.new_map(),
        claimed_orders: state_builder.new_set(),
        rules: AutoRules { auto_pay_limit: p.auto_pay_limit, objection_window_ms: p.objection_window_ms },
        assessed_at: state_builder.new_map(),
        objected: state_builder.new_set(),
        bond_rules: BondRules { objection_bond: p.objection_bond },
        terms: state_builder.new_map(),
        objection_bonds: state_builder.new_map(),
        bonds: state_builder.new_map(),
        rejected_at: state_builder.new_map(),
    })
}

#[derive(Serial, SchemaType, Debug, PartialEq, Eq)]
#[concordium(repr(u8))]
pub enum Event {
    #[concordium(tag = 0)]
    PolicyIssued { policy_id: u64, holder: AccountAddress, agent_payer: AccountAddress, limit: u64, premium: u64, valid_until: Timestamp },
    #[concordium(tag = 1)]
    ClaimFiled { claim_id: u64, policy_id: u64, claimant: AccountAddress, amount: u64 },
    #[concordium(tag = 2)]
    ClaimAssessed { claim_id: u64, ok: bool, reason: HashSha2256 },
    #[concordium(tag = 3)]
    ClaimDecided { claim_id: u64, approve: bool },
    #[concordium(tag = 4)]
    ClaimPaid { claim_id: u64, payout_tx: HashSha2256, amount: u64 },
    #[concordium(tag = 5)]
    ClaimFraud { claim_id: u64, disclosure: HashSha2256 },
    #[concordium(tag = 6)]
    PolicyCancelled { policy_id: u64 },
    #[concordium(tag = 7)]
    ClaimObjected { claim_id: u64, by: AccountAddress },
    #[concordium(tag = 8)]
    ClaimAutoApproved { claim_id: u64 },
    #[concordium(tag = 9)]
    ClaimFiledFor { claim_id: u64, by: AccountAddress },
    #[concordium(tag = 10)]
    TermsSet { policy_id: u64, terms: Terms },
    #[concordium(tag = 11)]
    ObjectionBondSettled { claim_id: u64, to: AccountAddress, amount: Amount },
    #[concordium(tag = 12)]
    BondPosted { payer: AccountAddress, poster: AccountAddress, amount: Amount },
    #[concordium(tag = 13)]
    BondSlashed { payer: AccountAddress, claim_id: u64, amount: Amount },
    #[concordium(tag = 14)]
    BondWithdrawn { payer: AccountAddress, amount: Amount },
}

fn sender_account(ctx: &ReceiveContext) -> CResult<AccountAddress> {
    match ctx.sender() {
        Address::Account(a) => Ok(a),
        Address::Contract(_) => Err(Error::OnlyAccount),
    }
}

fn only_operator(ctx: &ReceiveContext, host: &Host<State>) -> CResult<()> {
    ensure!(sender_account(ctx)? == host.state().operator, Error::Unauthorized);
    Ok(())
}

/// Claims may be filed up to this long after a policy ends (for orders inside its period).
const CLAIMS_WINDOW_MS: u64 = 30 * 86_400_000;

fn read_mandate(host: &Host<State>, key: &MandateKey) -> CResult<MandateEntry> {
    let registry = host.state().registry;
    let mut ret = host
        .invoke_contract_read_only(&registry, key, EntrypointName::new_unchecked("view"), Amount::zero())
        .map_err(|_| Error::RegistryCall)?
        .ok_or(Error::RegistryCall)?;
    let mandate: Option<MandateEntry> = ret.get().map_err(|_| Error::RegistryCall)?;
    mandate.ok_or(Error::MandateInvalid)
}

fn is_live(p: &Policy, now: Timestamp) -> bool {
    p.status == PolicyStatus::Active && p.valid_from <= now && now <= p.valid_until
}

/// Issue a policy after the premium settled. Checks the mandate in the kuasa registry.
#[receive(contract = "kuasa_cover", name = "issuePolicy", parameter = "IssuePolicy", return_value = "u64", error = "Error", mutable, enable_logger)]
fn issue_policy(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<u64> {
    only_operator(ctx, host)?;
    let p: IssuePolicy = ctx.parameter_cursor().get()?;
    let now = ctx.metadata().slot_time();
    ensure!(p.limit > 0 && p.valid_until > now && p.deductible < p.limit, Error::InvalidParams);

    let m = read_mandate(host, &p.mandate)?;
    ensure!(!m.revoked && m.valid_until >= now, Error::MandateInvalid);
    ensure!(m.owner == p.holder && m.payer == p.agent_payer && p.limit <= m.max_total, Error::MandateInvalid);

    let state = host.state_mut();
    let id = state.next_policy;
    state.next_policy += 1;
    let policy = Policy {
        holder: p.holder,
        agent_payer: p.agent_payer,
        agent_token: p.agent_token,
        mandate: p.mandate,
        kind: p.kind,
        limit: p.limit,
        deductible: p.deductible,
        premium: p.premium,
        premium_tx: p.premium_tx,
        valid_from: now,
        valid_until: p.valid_until,
        paid_out: 0,
        status: PolicyStatus::Active,
    };
    logger.log(&Event::PolicyIssued { policy_id: id, holder: policy.holder, agent_payer: policy.agent_payer, limit: policy.limit, premium: policy.premium, valid_until: policy.valid_until })?;
    let payer = policy.agent_payer;
    let _ = state.policies.insert(id, policy);
    state.by_payer.entry(payer).or_insert_with(Vec::new).modify(|v| v.push(id));
    Ok(id)
}

/// File a claim. Buyer claims come from the agent payer or the holder; merchant-loss claims
/// only from a merchant the mandate authorises to record receipts (so strangers cannot squat
/// orders). Each order backs at most one open claim per policy; a rejected claim releases it.
/// Claims close 30 days after the policy ends; whether each order falls inside the policy
/// period is checked by the assessor against the on-chain receipt.
#[receive(contract = "kuasa_cover", name = "fileClaim", parameter = "FileClaim", return_value = "u64", error = "Error", mutable, enable_logger)]
fn file_claim(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<u64> {
    let p: FileClaim = ctx.parameter_cursor().get()?;
    let claimant = sender_account(ctx)?;
    file(ctx, host, logger, p, claimant)
}

/// v3, parametric: the operator files a duplicate-order claim (AgentMistake) it detected on-chain,
/// on behalf of the agent. The claimant recorded is the agent payer, who is also the only possible
/// recipient; `ClaimFiledFor` shows who filed it. Assessment and decision work as for any claim.
#[receive(contract = "kuasa_cover", name = "fileClaimFor", parameter = "FileClaim", return_value = "u64", error = "Error", mutable, enable_logger)]
fn file_claim_for(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<u64> {
    only_operator(ctx, host)?;
    let p: FileClaim = ctx.parameter_cursor().get()?;
    ensure!(p.kind == ClaimKind::AgentMistake && p.orders.len() == 2, Error::InvalidParams);
    let payer = host.state().policies.get(&p.policy_id).ok_or(Error::NotFound)?.agent_payer;
    let id = file(ctx, host, logger, p, payer)?;
    logger.log(&Event::ClaimFiledFor { claim_id: id, by: sender_account(ctx)? })?;
    Ok(id)
}

fn file(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger, p: FileClaim, claimant: AccountAddress) -> CResult<u64> {
    ensure!(!p.orders.is_empty() && p.orders.len() <= 2 && p.amount > 0, Error::InvalidParams);
    let now = ctx.metadata().slot_time();
    let (mandate_key, payer, holder) = {
        let policy = host.state().policies.get(&p.policy_id).ok_or(Error::NotFound)?;
        ensure!(policy.status == PolicyStatus::Active, Error::PolicyInactive);
        let closes = policy.valid_until.checked_add(Duration::from_millis(CLAIMS_WINDOW_MS)).ok_or(Error::InvalidParams)?;
        ensure!(now <= closes, Error::PolicyInactive);
        (policy.mandate, policy.agent_payer, policy.holder)
    };
    if p.kind == ClaimKind::MerchantLoss {
        ensure!(read_mandate(host, &mandate_key)?.recorders.contains(&claimant), Error::Unauthorized);
    } else {
        ensure!(claimant == payer || claimant == holder, Error::Unauthorized);
    }
    let state = host.state_mut();
    for o in p.orders.iter() {
        ensure!(!state.claimed_orders.contains(&(p.policy_id, *o)), Error::OrderAlreadyClaimed);
    }
    for o in p.orders.iter() {
        let _ = state.claimed_orders.insert((p.policy_id, *o));
    }
    let id = state.next_claim;
    state.next_claim += 1;
    logger.log(&Event::ClaimFiled { claim_id: id, policy_id: p.policy_id, claimant, amount: p.amount })?;
    let _ = state.claims.insert(id, Claim {
        policy_id: p.policy_id,
        claimant,
        kind: p.kind,
        amount: p.amount,
        evidence: p.evidence,
        orders: p.orders,
        status: ClaimStatus::Filed,
        payout: 0,
    });
    Ok(id)
}

/// Record the rule-based assessment (operator).
#[receive(contract = "kuasa_cover", name = "assessClaim", parameter = "AssessParams", error = "Error", mutable, enable_logger)]
fn assess_claim(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    only_operator(ctx, host)?;
    let p: AssessParams = ctx.parameter_cursor().get()?;
    let mut c = host.state_mut().claims.get_mut(&p.claim_id).ok_or(Error::NotFound)?;
    ensure!(matches!(c.status, ClaimStatus::Filed | ClaimStatus::Assessed { .. }), Error::WrongStatus);
    c.status = ClaimStatus::Assessed { ok: p.ok, reason: p.reason };
    drop(c);
    let now = ctx.metadata().slot_time();
    let _ = host.state_mut().assessed_at.insert(p.claim_id, now); // the objection window starts here
    logger.log(&Event::ClaimAssessed { claim_id: p.claim_id, ok: p.ok, reason: p.reason })?;
    Ok(())
}

/// Human decision, submitted by the operator. Approval requires a positive assessment.
#[receive(contract = "kuasa_cover", name = "decideClaim", parameter = "DecideParams", error = "Error", mutable, enable_logger)]
fn decide_claim(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    only_operator(ctx, host)?;
    let p: DecideParams = ctx.parameter_cursor().get()?;
    let state = host.state_mut();
    let (policy_id, orders) = {
        let mut c = state.claims.get_mut(&p.claim_id).ok_or(Error::NotFound)?;
        c.status = match (c.status, p.approve) {
            (ClaimStatus::Assessed { ok: true, .. }, true) => ClaimStatus::Approved,
            (ClaimStatus::Filed | ClaimStatus::Assessed { .. }, false) => ClaimStatus::Rejected,
            _ => bail!(Error::WrongStatus),
        };
        (c.policy_id, c.orders.clone())
    };
    if !p.approve {
        for o in orders {
            state.claimed_orders.remove(&(policy_id, o));
        }
        let _ = state.rejected_at.insert(p.claim_id, ctx.metadata().slot_time());
    }
    logger.log(&Event::ClaimDecided { claim_id: p.claim_id, approve: p.approve })?;
    // Objection bonds: an upheld objection (claim rejected) gets its bond back; a failed one
    // (claim approved anyway) forfeits it to the operator, for the pool.
    let bonds = host.state().objection_bonds.get(&p.claim_id).map(|b| b.clone()).unwrap_or_default();
    let operator = host.state().operator;
    for (by, amount) in bonds {
        let to = if p.approve { operator } else { by };
        host.invoke_transfer(&to, amount).map_err(|_| Error::TransferFailed)?;
        logger.log(&Event::ObjectionBondSettled { claim_id: p.claim_id, to, amount })?;
    }
    host.state_mut().objection_bonds.remove(&p.claim_id);
    Ok(())
}

/// The rules that apply to a policy: its own terms where they are stricter, the published rules otherwise.
fn effective_rules(host: &Host<State>, policy_id: u64) -> AutoRules {
    let r = host.state().rules;
    match host.state().terms.get(&policy_id) {
        Some(t) => AutoRules { auto_pay_limit: r.auto_pay_limit.min(t.auto_pay_limit), objection_window_ms: r.objection_window_ms.max(t.objection_window_ms) },
        None => r,
    }
}

fn window_end(host: &Host<State>, claim_id: u64) -> CResult<Timestamp> {
    let at = host.state().assessed_at.get(&claim_id).map(|t| *t).ok_or(Error::WrongStatus)?;
    let policy_id = host.state().claims.get(&claim_id).ok_or(Error::NotFound)?.policy_id;
    at.checked_add(Duration::from_millis(effective_rules(host, policy_id).objection_window_ms)).ok_or(Error::InvalidParams)
}

/// During the objection window a party to the claim (policy holder, agent payer, claimant, or a
/// recorder of the mandate, i.e. the merchant) can object; an objected claim is never approved
/// automatically, only by a human decision.
/// v3: the objector locks at least `objection_bond` CCD with the objection.
#[receive(contract = "kuasa_cover", name = "objectClaim", parameter = "u64", error = "Error", mutable, payable, enable_logger)]
fn object_claim(ctx: &ReceiveContext, host: &mut Host<State>, amount: Amount, logger: &mut Logger) -> CResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let by = sender_account(ctx)?;
    ensure!(amount >= host.state().bond_rules.objection_bond, Error::BondTooSmall);
    let (policy_id, claimant) = {
        let c = host.state().claims.get(&id).ok_or(Error::NotFound)?;
        ensure!(matches!(c.status, ClaimStatus::Assessed { ok: true, .. }), Error::WrongStatus);
        (c.policy_id, c.claimant)
    };
    ensure!(ctx.metadata().slot_time() < window_end(host, id)?, Error::WrongStatus);
    let (holder, payer, mandate) = {
        let p = host.state().policies.get(&policy_id).ok_or(Error::NotFound)?;
        (p.holder, p.agent_payer, p.mandate)
    };
    let party = by == holder || by == payer || by == claimant || read_mandate(host, &mandate)?.recorders.contains(&by);
    ensure!(party, Error::Unauthorized);
    let _ = host.state_mut().objected.insert(id);
    if amount > Amount::zero() {
        host.state_mut().objection_bonds.entry(id).or_insert_with(Vec::new).modify(|v| v.push((by, amount)));
    }
    logger.log(&Event::ClaimObjected { claim_id: id, by })?;
    Ok(())
}

/// Automatic approval (operator), only within the published rules: a positively assessed claim,
/// not a wrong item, at most `auto_pay_limit` above the deductible, after the objection window,
/// and with no objection. Everything else needs `decideClaim` (a human).
#[receive(contract = "kuasa_cover", name = "autoApprove", parameter = "u64", error = "Error", mutable, enable_logger)]
fn auto_approve(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    only_operator(ctx, host)?;
    let id: u64 = ctx.parameter_cursor().get()?;
    ensure!(ctx.metadata().slot_time() >= window_end(host, id)?, Error::WrongStatus);
    ensure!(!host.state().objected.contains(&id), Error::Unauthorized);
    let (kind, amount, policy_id) = {
        let c = host.state().claims.get(&id).ok_or(Error::NotFound)?;
        ensure!(matches!(c.status, ClaimStatus::Assessed { ok: true, .. }), Error::WrongStatus);
        (c.kind, c.amount, c.policy_id)
    };
    ensure!(kind != ClaimKind::WrongItem, Error::Unauthorized);
    let deductible = host.state().policies.get(&policy_id).ok_or(Error::NotFound)?.deductible;
    ensure!(amount.saturating_sub(deductible) <= effective_rules(host, policy_id).auto_pay_limit, Error::OverLimit);
    host.state_mut().claims.get_mut(&id).ok_or(Error::NotFound)?.status = ClaimStatus::Approved;
    logger.log(&Event::ClaimAutoApproved { claim_id: id })?;
    Ok(())
}

#[receive(contract = "kuasa_cover", name = "rules", return_value = "AutoRules", error = "Error")]
fn view_rules(_ctx: &ReceiveContext, host: &Host<State>) -> CResult<AutoRules> {
    Ok(host.state().rules)
}

/// Record the treasury payout of an approved claim; never beyond the policy limit.
#[receive(contract = "kuasa_cover", name = "recordPayout", parameter = "PayoutParams", error = "Error", mutable, enable_logger)]
fn record_payout(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    only_operator(ctx, host)?;
    let p: PayoutParams = ctx.parameter_cursor().get()?;
    let state = host.state_mut();
    let policy_id = {
        let c = state.claims.get(&p.claim_id).ok_or(Error::NotFound)?;
        ensure!(c.status == ClaimStatus::Approved, Error::WrongStatus);
        c.policy_id
    };
    {
        let mut policy = state.policies.get_mut(&policy_id).ok_or(Error::NotFound)?;
        let paid = policy.paid_out.checked_add(p.amount).ok_or(Error::OverLimit)?;
        ensure!(p.amount > 0 && paid <= policy.limit, Error::OverLimit);
        policy.paid_out = paid;
    }
    let mut c = state.claims.get_mut(&p.claim_id).ok_or(Error::NotFound)?;
    c.status = ClaimStatus::Paid { payout_tx: p.payout_tx };
    c.payout = p.amount;
    logger.log(&Event::ClaimPaid { claim_id: p.claim_id, payout_tx: p.payout_tx, amount: p.amount })?;
    Ok(())
}

/// Mark a rejected claim as fraudulent, anchoring the lawful-disclosure request hash.
#[receive(contract = "kuasa_cover", name = "markFraud", parameter = "FraudParams", error = "Error", mutable, enable_logger)]
fn mark_fraud(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    only_operator(ctx, host)?;
    let p: FraudParams = ctx.parameter_cursor().get()?;
    let mut c = host.state_mut().claims.get_mut(&p.claim_id).ok_or(Error::NotFound)?;
    ensure!(c.status == ClaimStatus::Rejected, Error::WrongStatus);
    c.status = ClaimStatus::Fraud { disclosure: p.disclosure };
    let policy_id = c.policy_id;
    drop(c);
    logger.log(&Event::ClaimFraud { claim_id: p.claim_id, disclosure: p.disclosure })?;
    // Proven fraud costs the agent's operator its bond, paid to the operator for the pool.
    let payer = host.state().policies.get(&policy_id).ok_or(Error::NotFound)?.agent_payer;
    let bond = host.state().bonds.get(&payer).map(|b| *b);
    if let Some(b) = bond {
        host.state_mut().bonds.remove(&payer);
        let operator = host.state().operator;
        host.invoke_transfer(&operator, b.amount).map_err(|_| Error::TransferFailed)?;
        logger.log(&Event::BondSlashed { payer, claim_id: p.claim_id, amount: b.amount })?;
    }
    Ok(())
}

/// v3: the operator sets a policy's terms once, right after issuing it. They can only tighten the
/// published rules (`effective_rules` takes the stricter value of each).
#[receive(contract = "kuasa_cover", name = "setTerms", parameter = "SetTerms", error = "Error", mutable, enable_logger)]
fn set_terms(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    only_operator(ctx, host)?;
    let p: SetTerms = ctx.parameter_cursor().get()?;
    ensure!(host.state().policies.get(&p.policy_id).is_some(), Error::NotFound);
    ensure!(host.state().terms.get(&p.policy_id).is_none(), Error::WrongStatus);
    let _ = host.state_mut().terms.insert(p.policy_id, p.terms);
    logger.log(&Event::TermsSet { policy_id: p.policy_id, terms: p.terms })?;
    Ok(())
}

#[receive(contract = "kuasa_cover", name = "terms", parameter = "u64", return_value = "Option<Terms>", error = "Error")]
fn view_terms(ctx: &ReceiveContext, host: &Host<State>) -> CResult<Option<Terms>> {
    let id: u64 = ctx.parameter_cursor().get()?;
    Ok(host.state().terms.get(&id).map(|t| *t))
}

#[receive(contract = "kuasa_cover", name = "bondRules", return_value = "BondRules", error = "Error")]
fn view_bond_rules(_ctx: &ReceiveContext, host: &Host<State>) -> CResult<BondRules> {
    Ok(host.state().bond_rules)
}

/// v3: an agent operator bonds its agent payer with CCD. Only the first poster may add to it.
#[receive(contract = "kuasa_cover", name = "postBond", parameter = "AccountAddress", error = "Error", mutable, payable, enable_logger)]
fn post_bond(ctx: &ReceiveContext, host: &mut Host<State>, amount: Amount, logger: &mut Logger) -> CResult<()> {
    let payer: AccountAddress = ctx.parameter_cursor().get()?;
    let poster = sender_account(ctx)?;
    ensure!(amount > Amount::zero(), Error::InvalidParams);
    let total = match host.state().bonds.get(&payer).map(|b| *b) {
        Some(b) => {
            ensure!(b.poster == poster, Error::Unauthorized);
            b.amount + amount
        }
        None => amount,
    };
    let _ = host.state_mut().bonds.insert(payer, Bond { poster, amount: total });
    logger.log(&Event::BondPosted { payer, poster, amount })?;
    Ok(())
}

#[receive(contract = "kuasa_cover", name = "bondOf", parameter = "AccountAddress", return_value = "Option<Bond>", error = "Error")]
fn view_bond(ctx: &ReceiveContext, host: &Host<State>) -> CResult<Option<Bond>> {
    let payer: AccountAddress = ctx.parameter_cursor().get()?;
    Ok(host.state().bonds.get(&payer).map(|b| *b))
}

/// v3: the poster takes the bond back, but not while a claim on this payer's policies is open
/// (filed, assessed or approved and unpaid) or was rejected less than 30 days ago (it may still
/// be marked as fraud).
#[receive(contract = "kuasa_cover", name = "withdrawBond", parameter = "AccountAddress", error = "Error", mutable, enable_logger)]
fn withdraw_bond(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    let payer: AccountAddress = ctx.parameter_cursor().get()?;
    let b = host.state().bonds.get(&payer).map(|b| *b).ok_or(Error::NotFound)?;
    ensure!(b.poster == sender_account(ctx)?, Error::Unauthorized);
    let now = ctx.metadata().slot_time();
    let policies = host.state().by_payer.get(&payer).map(|v| v.clone()).unwrap_or_default();
    for (id, c) in host.state().claims.iter() {
        if !policies.contains(&c.policy_id) {
            continue;
        }
        let open = matches!(c.status, ClaimStatus::Filed | ClaimStatus::Assessed { .. } | ClaimStatus::Approved);
        let recent = c.status == ClaimStatus::Rejected
            && host.state().rejected_at.get(&*id).map(|t| t.checked_add(Duration::from_millis(CLAIMS_WINDOW_MS)).map(|e| now < e).unwrap_or(true)).unwrap_or(true);
        ensure!(!open && !recent, Error::BondLocked);
    }
    host.state_mut().bonds.remove(&payer);
    host.invoke_transfer(&b.poster, b.amount).map_err(|_| Error::TransferFailed)?;
    logger.log(&Event::BondWithdrawn { payer, amount: b.amount })?;
    Ok(())
}

/// The holder cancels a policy; no new claims after that.
#[receive(contract = "kuasa_cover", name = "cancelPolicy", parameter = "u64", error = "Error", mutable, enable_logger)]
fn cancel_policy(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> CResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let sender = sender_account(ctx)?;
    let mut p = host.state_mut().policies.get_mut(&id).ok_or(Error::NotFound)?;
    ensure!(p.holder == sender, Error::Unauthorized);
    p.status = PolicyStatus::Cancelled;
    logger.log(&Event::PolicyCancelled { policy_id: id })?;
    Ok(())
}

#[receive(contract = "kuasa_cover", name = "policy", parameter = "u64", return_value = "Option<Policy>", error = "Error")]
fn view_policy(ctx: &ReceiveContext, host: &Host<State>) -> CResult<Option<Policy>> {
    let id: u64 = ctx.parameter_cursor().get()?;
    Ok(host.state().policies.get(&id).map(|p| p.clone()))
}

#[receive(contract = "kuasa_cover", name = "claim", parameter = "u64", return_value = "Option<Claim>", error = "Error")]
fn view_claim(ctx: &ReceiveContext, host: &Host<State>) -> CResult<Option<Claim>> {
    let id: u64 = ctx.parameter_cursor().get()?;
    Ok(host.state().claims.get(&id).map(|c| c.clone()))
}

/// Live cover for an agent payer right now: remaining period cover, and the order-specific
/// cover for `order` if given.
#[receive(contract = "kuasa_cover", name = "coverOf", parameter = "CoverQuery", return_value = "CoverView", error = "Error")]
fn cover_of(ctx: &ReceiveContext, host: &Host<State>) -> CResult<CoverView> {
    let q: CoverQuery = ctx.parameter_cursor().get()?;
    let now = ctx.metadata().slot_time();
    let mut view = CoverView { period_remaining: 0, order_limit: 0, policy_id: None };
    let ids = host.state().by_payer.get(&q.payer).map(|v| v.clone()).unwrap_or_default();
    for id in ids {
        let Some(p) = host.state().policies.get(&id) else { continue };
        if !is_live(&p, now) {
            continue;
        }
        let left = p.limit.saturating_sub(p.paid_out);
        match p.kind {
            PolicyKind::Period if left > view.period_remaining => {
                view.period_remaining = left;
                view.policy_id = Some(id);
            }
            PolicyKind::Order(h) if Some(h) == q.order && left > view.order_limit => {
                view.order_limit = left;
                if view.policy_id.is_none() {
                    view.policy_id = Some(id);
                }
            }
            _ => {}
        }
    }
    Ok(view)
}

/// True iff the claim is approved by a human and not yet paid. A Protocol-Level Lock
/// (Enhanced) holding the pool can call this to authorise a release.
#[receive(contract = "kuasa_cover", name = "claimsAuthorized", parameter = "u64", return_value = "bool", error = "Error")]
fn claims_authorized(ctx: &ReceiveContext, host: &Host<State>) -> CResult<bool> {
    let id: u64 = ctx.parameter_cursor().get()?;
    Ok(host.state().claims.get(&id).map(|c| c.status == ClaimStatus::Approved).unwrap_or(false))
}
