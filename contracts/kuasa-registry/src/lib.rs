//! # Kuasa registry
//!
//! A *kuasa* (Indonesian: power of attorney) is a scoped, revocable mandate that lets an
//! AI agent spend on behalf of a verified principal.
//!
//! The full mandate document (scope, categories, ZK proof reference) lives off-chain; this
//! contract anchors its SHA-256 and enforces the parts that must be authoritative on-chain:
//!
//! * who issued it (the owner account, which is identity-backed like every Concordium account),
//! * which account may spend under it (the agent's payer account),
//! * the total budget and cumulative spend (updated by authorised recorders after settlement),
//! * expiry and revocation (owner can revoke at any time; effective immediately),
//! * incident reports (anyone can file evidence against a mandate; it stays on-chain).
#![cfg_attr(target_arch = "wasm32", no_std)]

use concordium_std::*;

/// Mandate id = SHA-256 of the canonical off-chain mandate document.
pub type MandateId = HashSha2256;

/// Recorders are kept small on purpose (a merchant's facilitator or two).
const MAX_RECORDERS: usize = 8;
const MAX_URI_LEN: usize = 512;

#[derive(Serial, Deserial, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct MandateEntry {
    pub owner: AccountAddress,
    pub payer: AccountAddress,
    /// CIS-8004 agent token this mandate is attached to.
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

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    mandates: StateMap<MandateId, MandateEntry, S>,
}

#[derive(Debug, PartialEq, Eq, Reject, Serialize, SchemaType)]
pub enum Error {
    #[from(ParseError)]
    Parse,
    OnlyAccount,
    AlreadyExists,
    NotFound,
    Unauthorized,
    Revoked,
    Expired,
    BudgetExceeded,
    InvalidParams,
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

pub type KResult<T> = Result<T, Error>;

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct IssueParams {
    pub id: MandateId,
    pub payer: AccountAddress,
    pub agent_registry: ContractAddress,
    pub agent_token: String,
    pub uri: String,
    pub max_total: u64,
    pub valid_until: Timestamp,
    pub recorders: Vec<AccountAddress>,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct RevokeParams {
    pub id: MandateId,
    /// SHA-256 of a reason / evidence document (optional transparency).
    pub reason: HashSha2256,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct ReceiptParams {
    pub id: MandateId,
    /// SHA-256 of the canonical order (merchant, items, amount, asset, category).
    pub order: HashSha2256,
    /// Hash of the x402 settlement transaction that moved the funds.
    pub payment_tx: HashSha2256,
    pub amount: u64,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct IncidentParams {
    pub id: MandateId,
    pub evidence: HashSha2256,
}

#[derive(Serial, SchemaType, Debug, PartialEq, Eq)]
#[concordium(repr(u8))]
pub enum Event {
    #[concordium(tag = 0)]
    Issued { id: MandateId, owner: AccountAddress, payer: AccountAddress, max_total: u64, valid_until: Timestamp },
    #[concordium(tag = 1)]
    Revoked { id: MandateId, by: AccountAddress, reason: HashSha2256 },
    #[concordium(tag = 2)]
    Receipt { id: MandateId, order: HashSha2256, payment_tx: HashSha2256, amount: u64, spent: u64 },
    #[concordium(tag = 3)]
    Incident { id: MandateId, reporter: Address, evidence: HashSha2256 },
}

fn sender_account(ctx: &ReceiveContext) -> KResult<AccountAddress> {
    match ctx.sender() {
        Address::Account(a) => Ok(a),
        Address::Contract(_) => Err(Error::OnlyAccount),
    }
}

#[init(contract = "kuasa", event = "Event")]
fn init(_ctx: &InitContext, state_builder: &mut StateBuilder) -> InitResult<State> {
    Ok(State { mandates: state_builder.new_map() })
}

/// Issue a mandate. The transaction sender becomes the owner.
#[receive(contract = "kuasa", name = "issue", parameter = "IssueParams", error = "Error", mutable, enable_logger)]
fn issue(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> KResult<()> {
    let p: IssueParams = ctx.parameter_cursor().get()?;
    let owner = sender_account(ctx)?;
    ensure!(p.uri.len() <= MAX_URI_LEN && p.recorders.len() <= MAX_RECORDERS && p.max_total > 0, Error::InvalidParams);
    ensure!(p.valid_until > ctx.metadata().slot_time(), Error::Expired);
    ensure!(host.state().mandates.get(&p.id).is_none(), Error::AlreadyExists);

    let entry = MandateEntry {
        owner,
        payer: p.payer,
        agent_registry: p.agent_registry,
        agent_token: p.agent_token,
        uri: p.uri,
        max_total: p.max_total,
        spent: 0,
        valid_until: p.valid_until,
        revoked: false,
        recorders: p.recorders,
        receipts: 0,
        incidents: 0,
    };
    logger.log(&Event::Issued { id: p.id, owner, payer: entry.payer, max_total: entry.max_total, valid_until: entry.valid_until })?;
    let _ = host.state_mut().mandates.insert(p.id, entry); // absent: checked above
    Ok(())
}

/// Revoke a mandate. Only the owner can revoke; effective for every merchant immediately.
#[receive(contract = "kuasa", name = "revoke", parameter = "RevokeParams", error = "Error", mutable, enable_logger)]
fn revoke(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> KResult<()> {
    let p: RevokeParams = ctx.parameter_cursor().get()?;
    let by = sender_account(ctx)?;
    let mut m = host.state_mut().mandates.get_mut(&p.id).ok_or(Error::NotFound)?;
    ensure!(m.owner == by, Error::Unauthorized);
    m.revoked = true;
    logger.log(&Event::Revoked { id: p.id, by, reason: p.reason })?;
    Ok(())
}

/// Record a settled purchase against the mandate budget. Only authorised recorders
/// (e.g. the merchant's x402 facilitator) may call this. Rejects when the mandate is
/// revoked, expired or the budget would be exceeded.
#[receive(contract = "kuasa", name = "recordReceipt", parameter = "ReceiptParams", error = "Error", mutable, enable_logger)]
fn record_receipt(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> KResult<()> {
    let p: ReceiptParams = ctx.parameter_cursor().get()?;
    let by = sender_account(ctx)?;
    let now = ctx.metadata().slot_time();
    let mut m = host.state_mut().mandates.get_mut(&p.id).ok_or(Error::NotFound)?;
    ensure!(m.recorders.contains(&by), Error::Unauthorized);
    ensure!(!m.revoked, Error::Revoked);
    ensure!(now <= m.valid_until, Error::Expired);
    let spent = m.spent.checked_add(p.amount).ok_or(Error::BudgetExceeded)?;
    ensure!(spent <= m.max_total, Error::BudgetExceeded);
    m.spent = spent;
    m.receipts += 1;
    logger.log(&Event::Receipt { id: p.id, order: p.order, payment_tx: p.payment_tx, amount: p.amount, spent })?;
    Ok(())
}

/// File an incident (fraud, out-of-scope purchase, harm). Anyone can report; reports
/// are permanent and counted, giving merchants and the owner an on-chain signal and an
/// evidence trail for the lawful identity-disclosure process.
#[receive(contract = "kuasa", name = "reportIncident", parameter = "IncidentParams", error = "Error", mutable, enable_logger)]
fn report_incident(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> KResult<()> {
    let p: IncidentParams = ctx.parameter_cursor().get()?;
    let mut m = host.state_mut().mandates.get_mut(&p.id).ok_or(Error::NotFound)?;
    m.incidents += 1;
    logger.log(&Event::Incident { id: p.id, reporter: ctx.sender(), evidence: p.evidence })?;
    Ok(())
}

/// Read a mandate.
#[receive(contract = "kuasa", name = "view", parameter = "MandateId", return_value = "Option<MandateEntry>", error = "Error")]
fn view(ctx: &ReceiveContext, host: &Host<State>) -> KResult<Option<MandateEntry>> {
    let id: MandateId = ctx.parameter_cursor().get()?;
    Ok(host.state().mandates.get(&id).map(|m| m.clone()))
}
