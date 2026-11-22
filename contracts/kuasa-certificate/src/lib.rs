//! Kuasa Cover certificates: one CIS-2 token per policy, held by the insured agent's payer account for as
//! long as the policy is live. Nothing is minted or burned by hand: `balanceOf` reads the policy from the
//! kuasa-cover contract on every call, so a cancelled or expired policy shows 0 at once, and a wallet or
//! explorer that speaks CIS-2 shows "insured" without asking Kuasa. Certificates cannot be transferred: they
//! follow the policy. `announce` and `retire` only log the CIS-2 mint and burn events, so indexers list them.
#![cfg_attr(target_arch = "wasm32", no_std)]
use concordium_cis2::*;
use concordium_std::*;

pub type ContractTokenId = TokenIdU64;
pub type ContractTokenAmount = TokenAmountU8;

#[derive(Serialize, SchemaType)]
pub struct InitParams {
    /// The kuasa-cover contract whose policies these certificates mirror.
    pub cover: ContractAddress,
    /// CIS-2 metadata for every certificate (name, description, image).
    pub metadata_url: String,
}

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S: HasStateApi = StateApi> {
    cover: ContractAddress,
    metadata_url: String,
    /// policies whose mint event was logged (so indexers see each certificate once)
    announced: StateSet<u64, S>,
}

/// kuasa-cover's `policy` view, mirrored for reading only (same wire format).
#[derive(Deserial)]
pub struct CoverMandateKey { pub owner: AccountAddress, pub id: HashSha2256 }
#[derive(Deserial)]
pub enum CoverPolicyKind { Period, Order(HashSha2256) }
#[derive(Deserial, PartialEq, Eq)]
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

#[derive(Serialize, SchemaType, Debug, PartialEq, Eq, Reject)]
pub enum CustomError {
    #[from(ParseError)]
    ParseParams,
    #[from(LogError)]
    Log,
    CoverUnreadable,
    /// certificates follow their policy and cannot be transferred or delegated
    NotTransferable,
    NotLive,
    StillLive,
    AlreadyAnnounced,
    NotAnnounced,
}
pub type ContractError = Cis2Error<CustomError>;
pub type ContractResult<A> = Result<A, ContractError>;
impl From<CustomError> for ContractError { fn from(e: CustomError) -> Self { Cis2Error::Custom(e) } }

#[init(contract = "kuasa_certificate", parameter = "InitParams")]
fn init(ctx: &InitContext, state_builder: &mut StateBuilder) -> InitResult<State> {
    let p: InitParams = ctx.parameter_cursor().get()?;
    Ok(State { cover: p.cover, metadata_url: p.metadata_url, announced: state_builder.new_set() })
}

/// The account a live policy insures, or None (no such policy, cancelled, expired or limit used up).
fn live_holder(host: &Host<State>, now: Timestamp, policy_id: u64) -> ContractResult<Option<AccountAddress>> {
    let mut rv = host
        .invoke_contract_read_only(&host.state().cover, &policy_id, EntrypointName::new_unchecked("policy"), Amount::zero())
        .map_err(|_| CustomError::CoverUnreadable)?
        .ok_or(CustomError::CoverUnreadable)?;
    let p: Option<CoverPolicy> = rv.get().map_err(|_| CustomError::CoverUnreadable)?;
    Ok(p.filter(|p| p.status == CoverPolicyStatus::Active && p.valid_until > now && p.paid_out < p.limit).map(|p| p.agent_payer))
}

fn token_u64(t: &ContractTokenId) -> u64 { t.0 }

#[receive(contract = "kuasa_certificate", name = "balanceOf", parameter = "BalanceOfQueryParams<ContractTokenId>", return_value = "BalanceOfQueryResponse<ContractTokenAmount>", error = "ContractError")]
fn balance_of(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<BalanceOfQueryResponse<ContractTokenAmount>> {
    let params: BalanceOfQueryParams<ContractTokenId> = ctx.parameter_cursor().get()?;
    let now = ctx.metadata().slot_time();
    let mut out = Vec::with_capacity(params.queries.len());
    for q in params.queries {
        let holder = live_holder(host, now, token_u64(&q.token_id))?;
        out.push(TokenAmountU8(if holder.map(Address::Account) == Some(q.address) { 1 } else { 0 }));
    }
    Ok(BalanceOfQueryResponse::from(out))
}

#[receive(contract = "kuasa_certificate", name = "transfer", parameter = "TransferParams<ContractTokenId, ContractTokenAmount>", error = "ContractError", mutable)]
fn transfer(_ctx: &ReceiveContext, _host: &mut Host<State>) -> ContractResult<()> {
    Err(CustomError::NotTransferable.into())
}

#[receive(contract = "kuasa_certificate", name = "updateOperator", parameter = "UpdateOperatorParams", error = "ContractError", mutable)]
fn update_operator(_ctx: &ReceiveContext, _host: &mut Host<State>) -> ContractResult<()> {
    Err(CustomError::NotTransferable.into())
}

#[receive(contract = "kuasa_certificate", name = "operatorOf", parameter = "OperatorOfQueryParams", return_value = "OperatorOfQueryResponse", error = "ContractError")]
fn operator_of(ctx: &ReceiveContext, _host: &Host<State>) -> ContractResult<OperatorOfQueryResponse> {
    let params: OperatorOfQueryParams = ctx.parameter_cursor().get()?;
    Ok(OperatorOfQueryResponse::from(params.queries.iter().map(|_| false).collect::<Vec<_>>()))
}

#[receive(contract = "kuasa_certificate", name = "tokenMetadata", parameter = "TokenMetadataQueryParams<ContractTokenId>", return_value = "TokenMetadataQueryResponse", error = "ContractError")]
fn token_metadata(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<TokenMetadataQueryResponse> {
    let params: TokenMetadataQueryParams<ContractTokenId> = ctx.parameter_cursor().get()?;
    let url = host.state().metadata_url.clone();
    Ok(TokenMetadataQueryResponse::from(params.queries.iter().map(|_| MetadataUrl { url: url.clone(), hash: None }).collect::<Vec<_>>()))
}

#[receive(contract = "kuasa_certificate", name = "supports", parameter = "SupportsQueryParams", return_value = "SupportsQueryResponse", error = "ContractError")]
fn supports(ctx: &ReceiveContext, _host: &Host<State>) -> ContractResult<SupportsQueryResponse> {
    let params: SupportsQueryParams = ctx.parameter_cursor().get()?;
    let ids = [CIS0_STANDARD_IDENTIFIER, CIS2_STANDARD_IDENTIFIER];
    Ok(SupportsQueryResponse::from(params.queries.into_iter().map(|q| if ids.contains(&q.as_standard_identifier()) { SupportResult::Support } else { SupportResult::NoSupport }).collect::<Vec<_>>()))
}

/// Anyone: log the CIS-2 mint of a live policy's certificate (once), so indexers and explorers list it.
#[receive(contract = "kuasa_certificate", name = "announce", parameter = "ContractTokenId", error = "ContractError", mutable, enable_logger)]
fn announce(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut impl HasLogger) -> ContractResult<()> {
    let token_id: ContractTokenId = ctx.parameter_cursor().get()?;
    let holder = live_holder(host, ctx.metadata().slot_time(), token_u64(&token_id))?.ok_or(CustomError::NotLive)?;
    ensure!(host.state_mut().announced.insert(token_u64(&token_id)), CustomError::AlreadyAnnounced.into());
    logger.log(&Cis2Event::Mint(MintEvent { token_id, amount: TokenAmountU8(1), owner: Address::Account(holder) }))?;
    logger.log(&Cis2Event::TokenMetadata::<ContractTokenId, ContractTokenAmount>(TokenMetadataEvent { token_id, metadata_url: MetadataUrl { url: host.state().metadata_url.clone(), hash: None } }))?;
    Ok(())
}

/// Anyone: once the policy is no longer live, log the burn so indexers stop listing the certificate.
#[receive(contract = "kuasa_certificate", name = "retire", parameter = "ContractTokenId", error = "ContractError", mutable, enable_logger)]
fn retire(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut impl HasLogger) -> ContractResult<()> {
    let token_id: ContractTokenId = ctx.parameter_cursor().get()?;
    ensure!(live_holder(host, ctx.metadata().slot_time(), token_u64(&token_id))?.is_none(), CustomError::StillLive.into());
    let mut rv = host
        .invoke_contract_read_only(&host.state().cover, &token_u64(&token_id), EntrypointName::new_unchecked("policy"), Amount::zero())
        .map_err(|_| CustomError::CoverUnreadable)?
        .ok_or(CustomError::CoverUnreadable)?;
    let p: Option<CoverPolicy> = rv.get().map_err(|_| CustomError::CoverUnreadable)?;
    let owner = p.map(|p| p.agent_payer).ok_or(CustomError::NotLive)?;
    ensure!(host.state_mut().announced.remove(&token_u64(&token_id)), CustomError::NotAnnounced.into());
    logger.log(&Cis2Event::Burn::<ContractTokenId, ContractTokenAmount>(BurnEvent { token_id, amount: TokenAmountU8(1), owner: Address::Account(owner) }))?;
    Ok(())
}
