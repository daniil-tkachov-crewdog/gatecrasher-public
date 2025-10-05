# 📊 App Database Schema (public)

This document describes the main tables in the `public` schema and how they are related.

---

## 🧑 Users (`app_users`)
- **user_id** → unique ID of the user (same as Supabase Auth)
- **email** → user’s email
- **stripe_customer_id** → Stripe customer reference
- **created_at** → when the user joined

**Relations**
- Linked to **auth.users**
- One user can have many **subscriptions**
- One user has exactly one **quota**
- User may have **cancellation feedback**

---

## 💳 Subscriptions (`app_subscriptions`)
- **id** → unique subscription ID
- **user_id** → belongs to which user
- **stripe_subscription_id** → Stripe subscription reference
- **product_id / price_id** → plan details
- **status** → subscription state (active, canceled, trialing, etc.)
- **current_period_start / current_period_end** → billing cycle dates
- **cancel_at / cancel_at_period_end**
- **trial_end**
- **created_at / updated_at**

**Relations**
- Belongs to **app_users**
- Can have multiple **cancellation feedback** entries

---

## 🎟️ Quotas (`app_quotas`)
- **user_id** → which user this belongs to (also the primary key)
- **total_credits** → total credits available
- **used_credits** → credits consumed
- **period_start / period_end** → quota time window
- **last_reset_at**
- **has_claimed_free_try** → free trial claimed?
- **created_at / updated_at**

**Relations**
- Each user has exactly one **quota** (1:1 with `app_users`)

---

## ❌ Cancellation Feedback (`app_cancellation_feedback`)
- **id** → unique record ID
- **user_id** → who canceled
- **subscription_id** → which subscription was canceled
- **reason** → cancellation reason
- **other_text** → extra explanation
- **downgraded** → true if downgraded instead of canceling fully
- **created_at**

**Relations**
- Belongs to **auth.users** (via `user_id`)
- Belongs to **app_subscriptions** (via `subscription_id`)

---

# 🔗 Relationships Overview
- **AppUser.user_id → AuthUser.id**
- **AppSubscription.user_id → AppUser.user_id**
- **AppQuota.user_id → AppUser.user_id**
- **AppCancellationFeedback.user_id → AuthUser.id**
- **AppCancellationFeedback.subscription_id → AppSubscription.stripe_subscription_id**

---

⚡ **In simple terms:**
- `app_users` = who they are  
- `app_subscriptions` = what plan they’re on  
- `app_quotas` = how much they can use  
- `app_cancellation_feedback` = why they left  
