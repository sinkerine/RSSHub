{ pkgs, lib, ... }:

let
  projectRoot = builtins.getEnv "PWD";
  localConfig = projectRoot + "/devenv.local.nix";
in
{
  # Flake shells need the working checkout, rather than the copied store source.
  devenv.root = projectRoot;

  env = {
    NODE_ENV = "dev";
    NODE_OPTIONS = "--max-http-header-size=32768";
    CHROMIUM_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
  };

  packages = with pkgs; [ git prek chromium ];

  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_26;
    pnpm = {
      enable = true;
      package = pkgs.pnpm_12;
    };
  };

  # E2E uses memory caching; a developer can opt into Redis for manual work.
  services.redis = {
    enable = lib.mkDefault false;
    port = 6379;
  };

  scripts = {
    rsshub-setup.exec = ''
      agent-job run heavy -- bash scripts/dev-setup.sh
    '';
    rsshub-dev.exec = ''pnpm run dev "$@"'';
    rsshub-build.exec = ''agent-job run heavy -- pnpm run build "$@"'';
    rsshub-start.exec = ''pnpm start "$@"'';
    rsshub-test.exec = ''agent-job run heavy -- pnpm test "$@"'';
    rsshub-e2e.exec = ''pnpm run test:e2e "$@"'';
  };

  enterShell = ''
    echo "RSSHub: Node $(node --version), pnpm $(pnpm --version)"
    echo "Run rsshub-setup once, rsshub-dev for development, rsshub-e2e for the isolated smoke test."
  '';

  imports = lib.optional (builtins.pathExists localConfig) localConfig;
}
