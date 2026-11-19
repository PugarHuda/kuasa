//! # Kuasa Cover
//!
//! Insurance books for AI agent commerce. Policies cover an agent that shops under a Kuasa
//! mandate; claims are filed against on-chain evidence and paid only after a human approves.
//!
//! The pool itself is not held here: smart contracts cannot hold Protocol-Level Tokens yet, so
//! the EUDemo pool is an insurer treasury account and this contract keeps the books. Once
//! Protocol-Level Locks: Enhanced ship, the pool moves into a lock whose release is authorised
//! by `claimsAuthorized` below.
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
    }
    logger.log(&Event::ClaimDecided { claim_id: p.claim_id, approve: p.approve })?;
    Ok(())
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
    logger.log(&Event::ClaimFraud { claim_id: p.claim_id, disclosure: p.disclosure })?;
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
