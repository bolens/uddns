{ pkgs, config, lib, ... }:
let
  pnpm = pkgs.writeShellScriptBin "pnpm" ''
    exec ${pkgs.corepack}/bin/corepack pnpm "$@"
  '';
  developmentHome = pkgs.runCommand "development-home" { } ''
    mkdir -p "$out/env"
    ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
      # pnpm's pinned Node runtime uses the standard Linux ELF interpreter.
      mkdir -p "$out/lib" "$out/lib64"
      ln -s ${pkgs.stdenv.cc.bintools.dynamicLinker} "$out/lib/$(basename ${pkgs.stdenv.cc.bintools.dynamicLinker})"
      ln -s ${pkgs.stdenv.cc.bintools.dynamicLinker} "$out/lib64/$(basename ${pkgs.stdenv.cc.bintools.dynamicLinker})"
    ''}
  '';
in
{
  name = "uddns";
  # Use existing Nix caches without changing daemon trust configuration.
  cachix.enable = false;
  # This repository has no background services or process-compose configuration.
  process.manager.implementation = "overmind";
  packages = with pkgs; [
    bashInteractive coreutils findutils gawk git gnugrep gnused diffutils
    python3 nodejs_26 pnpm shellcheck ruff actionlint zizmor curl cacert
    gnutar gzip unzip openssl
  ];
  env = {
    LANG = if pkgs.stdenv.hostPlatform.isLinux then "C.UTF-8" else "en_US.UTF-8";
    LC_ALL = config.env.LANG;
    SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
  } // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
    LOCALE_ARCHIVE = "${pkgs.glibcLocales}/lib/locale/locale-archive";
  };
  scripts.repo-check.exec = "bash scripts/check-development.sh";
  enterTest = "repo-check";

  containers.shell = {
    name = "localhost/uddns-dev";
    version = "latest";
    # Mount source when running; never bake checkout files or local secrets in.
    copyToRoot = [ ];
    # Prepare the image's existing home; nothing is mounted here from the host.
    layers = lib.mkAfter [{
      copyToRoot = [ developmentHome ];
      perms = [{ path = developmentHome; regex = "/env"; mode = "1777"; }];
    }];
    entrypoint = [ (pkgs.writeShellScript "development-entrypoint" ''
      export PATH="${lib.makeBinPath config.packages}:$PATH"
      ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
        export LD_LIBRARY_PATH="${lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib pkgs.glibc ]}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
      ''}
      exec "$@"
    '') ];
    startupCommand = "bash";
  };
}
