use anyhow::Result;
use tracing_subscriber::{fmt, EnvFilter};

#[tokio::main]
async fn main() -> Result<()> {
    fmt().with_env_filter(EnvFilter::from_default_env()).init();

    let config = dispatch_gateway::config::Config::load()?;
    dispatch_gateway::server::run(config).await
}
