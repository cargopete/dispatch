use anyhow::Result;
use tracing_subscriber::{fmt, EnvFilter};

mod config;
mod oracle;

#[tokio::main]
async fn main() -> Result<()> {
    fmt().with_env_filter(EnvFilter::from_default_env()).init();
    let config = config::Config::load()?;
    oracle::run(config).await
}
