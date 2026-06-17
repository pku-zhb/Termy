class TermyServer < Formula
  desc "Terminal PTY backend for the Termy Obsidian plugin (魔改 fork)"
  homepage "https://github.com/pku-zhb/Termy"
  version "1.5.0"
  license "GPL-3.0-only"

  on_macos do
    on_arm do
      url "https://github.com/pku-zhb/Termy/releases/download/1.5.0/termy-server-darwin-arm64"
      sha256 "16fb30e15d69a6032511716070e0ef3cf986d1cd1aaba902ce4bd461bbc9317d"
    end
    # Intel 款 Mac 需要在 release 里补一个 termy-server-darwin-x86_64 资产，再加 on_intel 块。
  end

  def install
    # 下载的是单个预编译二进制（非压缩包），重命名安装到 bin。
    bin.install "termy-server-darwin-arm64" => "termy-server"
  end

  test do
    assert_predicate bin/"termy-server", :executable?
  end
end
