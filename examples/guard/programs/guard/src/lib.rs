//! token2022-integration-guard — reference guard program.
//!
//! A minimal, *exemplary* vault that safely CONSUMES an arbitrary Token-2022 mint.
//! It demonstrates the three integrator patterns the skill teaches, as compiled,
//! testable code:
//!
//!   1. Extension allowlist (default-deny) — reject mints whose extensions can
//!      rug or brick an integrator (PermanentDelegate, TransferHook, NonTransferable,
//!      DefaultAccountState=Frozen, ConfidentialTransfer, or anything unrecognized).
//!   2. Delta-measured, fee-safe deposits — credit the amount actually RECEIVED
//!      (post-transfer-fee), never the `amount` argument.
//!   3. Reentrancy-aware withdraws — checks-effects-interactions + a lock flag.
//!
//! This is a teaching artifact, not an audited production vault. See the skill docs.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::Mint as SplMint,
};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("4yGL5iFhDj1vaz2XmhPejauPZmdcRBUX6kkifhpxTXTH");

#[program]
pub mod guard {
    use super::*;

    /// Create a vault for `mint`. Fails closed if the mint carries any extension
    /// that is unsafe for an integrator to custody.
    pub fn init_vault(ctx: Context<InitVault>) -> Result<()> {
        enforce_extension_allowlist(&ctx.accounts.mint.to_account_info())?;

        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.mint = ctx.accounts.mint.key();
        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.total_deposited = 0;
        vault.locked = false;
        vault.bump = ctx.bumps.vault;
        Ok(())
    }

    /// Open a per-user position (explicit init avoids `init_if_needed` reinit risk).
    pub fn open_position(ctx: Context<OpenPosition>) -> Result<()> {
        let p = &mut ctx.accounts.position;
        p.owner = ctx.accounts.owner.key();
        p.vault = ctx.accounts.vault.key();
        p.deposited = 0;
        p.bump = ctx.bumps.position;
        Ok(())
    }

    /// Fee-safe deposit: credit the RECEIVED amount (measured by balance delta),
    /// never the `amount` argument. Under a transfer fee, received < amount.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        // Re-validate: a mint's transfer-hook authority can change after init.
        enforce_extension_allowlist(&ctx.accounts.mint.to_account_info())?;
        require!(amount > 0, GuardError::ZeroAmount);

        let before = ctx.accounts.vault_token_account.amount;

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        // MANDATORY after a CPI that mutates this account; cached `.amount` is stale.
        ctx.accounts.vault_token_account.reload()?;
        let after = ctx.accounts.vault_token_account.amount;
        let credited = after.checked_sub(before).ok_or(GuardError::Underflow)?;
        require!(credited > 0, GuardError::NothingReceived);

        let position = &mut ctx.accounts.position;
        position.deposited = position
            .deposited
            .checked_add(credited)
            .ok_or(GuardError::Overflow)?;
        let vault = &mut ctx.accounts.vault;
        vault.total_deposited = vault
            .total_deposited
            .checked_add(credited)
            .ok_or(GuardError::Overflow)?;

        emit!(Deposited {
            vault: vault.key(),
            owner: position.owner,
            requested: amount,
            credited,
        });
        Ok(())
    }

    /// Reentrancy-aware withdraw: checks-effects-interactions + lock flag.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        enforce_extension_allowlist(&ctx.accounts.mint.to_account_info())?;

        // 1) CHECK + LOCK.
        require!(!ctx.accounts.vault.locked, GuardError::Reentrancy);
        ctx.accounts.vault.locked = true;

        // 2) EFFECTS — mutate accounting BEFORE the external CPI.
        let position = &mut ctx.accounts.position;
        position.deposited = position
            .deposited
            .checked_sub(amount)
            .ok_or(GuardError::InsufficientBalance)?;
        let vault_total = ctx.accounts.vault.total_deposited;
        ctx.accounts.vault.total_deposited =
            vault_total.checked_sub(amount).ok_or(GuardError::Underflow)?;

        // 3) INTERACTION — PDA-signed transfer out.
        let mint_key = ctx.accounts.mint.key();
        let bump = ctx.accounts.vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", mint_key.as_ref(), &[bump]]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        // 4) UNLOCK.
        ctx.accounts.vault.locked = false;
        Ok(())
    }
}

/// Read every ExtensionType present on a mint's TLV data.
pub fn read_mint_extension_types(mint_ai: &AccountInfo) -> Result<Vec<ExtensionType>> {
    let data = mint_ai.try_borrow_data()?;
    let state = StateWithExtensions::<SplMint>::unpack(&data)
        .map_err(|_| error!(GuardError::NotAToken2022Mint))?;
    state
        .get_extension_types()
        .map_err(|_| error!(GuardError::CorruptExtensionData))
}

/// Default-deny allowlist. Explicitly forbids the known-dangerous extensions for
/// better errors, and rejects ANY extension not on the small allow set.
pub fn enforce_extension_allowlist(mint_ai: &AccountInfo) -> Result<()> {
    const ALLOWED: &[ExtensionType] = &[
        ExtensionType::TransferFeeConfig, // handled via delta-measured deposit
        ExtensionType::TransferFeeAmount,
        ExtensionType::MetadataPointer,
        ExtensionType::TokenMetadata,
        ExtensionType::ImmutableOwner,
    ];
    for ext in read_mint_extension_types(mint_ai)? {
        match ext {
            ExtensionType::TransferHook
            | ExtensionType::PermanentDelegate
            | ExtensionType::NonTransferable
            | ExtensionType::DefaultAccountState
            | ExtensionType::ConfidentialTransferMint => {
                return err!(GuardError::ForbiddenExtension)
            }
            ExtensionType::Uninitialized => {}
            other if !ALLOWED.contains(&other) => return err!(GuardError::UnsupportedExtension),
            _ => {}
        }
    }
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub total_deposited: u64,
    pub locked: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub deposited: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = Vault::DISCRIMINATOR.len() + Vault::INIT_SPACE,
        seeds = [b"vault", mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"vault", vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = owner,
        space = Position::DISCRIMINATOR.len() + Position::INIT_SPACE,
        seeds = [b"position", vault.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(address = vault.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = user,
        token::token_program = token_program
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = owner @ GuardError::WrongOwner
    )]
    pub position: Account<'info, Position>,
    /// CHECK: only used to bind the position's owner via has_one.
    #[account(address = user.key())]
    pub owner: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(address = vault.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = user,
        token::token_program = token_program
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = owner @ GuardError::WrongOwner
    )]
    pub position: Account<'info, Position>,
    /// CHECK: only used to bind the position's owner via has_one.
    #[account(address = user.key())]
    pub owner: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub requested: u64,
    pub credited: u64,
}

#[error_code]
pub enum GuardError {
    #[msg("Mint carries an extension that is forbidden for integrators")]
    ForbiddenExtension,
    #[msg("Mint carries an extension this vault does not support (default-deny)")]
    UnsupportedExtension,
    #[msg("Account is not a valid Token-2022/SPL mint")]
    NotAToken2022Mint,
    #[msg("Mint extension data is corrupt or unreadable")]
    CorruptExtensionData,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Transfer credited nothing (fee consumed the whole amount)")]
    NothingReceived,
    #[msg("Reentrancy detected: vault is locked")]
    Reentrancy,
    #[msg("Insufficient position balance")]
    InsufficientBalance,
    #[msg("Position owner mismatch")]
    WrongOwner,
    #[msg("Arithmetic underflow")]
    Underflow,
    #[msg("Arithmetic overflow")]
    Overflow,
}
