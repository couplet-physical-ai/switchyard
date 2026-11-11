//! Switchyard server library: the fleet model, the order-independent store,
//! fan-out, history, queries, upstream adapters and the HTTP surface.

pub mod adapters;
pub mod api;
pub mod auth;
pub mod demo;
pub mod facts;
pub mod google;
pub mod history;
pub mod hub;
pub mod ledger;
pub mod model;
pub mod query;
pub mod record;
pub mod runtime;
pub mod signature;
pub mod store;
pub mod traces;
pub mod wire;
