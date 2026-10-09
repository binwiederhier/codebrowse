BIN := $(HOME)/.local/bin/codebrowse
UNIT := $(HOME)/.config/systemd/user/codebrowse.service

.PHONY: build check-deps install uninstall restart logs password

build:
	go build -o codebrowse .

check-deps:
	@command -v go >/dev/null || { echo "go is not installed (need Go 1.24+)"; exit 1; }
	@command -v git >/dev/null || { echo "git is not installed"; exit 1; }
	@command -v gopls >/dev/null || test -x $(HOME)/go/bin/gopls || { echo "gopls not found; install with: go install golang.org/x/tools/gopls@latest"; exit 1; }

install: check-deps build
	mkdir -p $(dir $(BIN)) $(dir $(UNIT))
	install -m 755 codebrowse $(BIN)
	cp codebrowse.service $(UNIT)
	systemctl --user daemon-reload
	systemctl --user enable codebrowse
	systemctl --user restart codebrowse
	@sleep 1
	@echo "codebrowse is running: $$(grep -o '"listen": *"[^"]*"' $(HOME)/.config/codebrowse/config.json)"
	@echo "password: $$($(BIN) -print-password)"

uninstall:
	-systemctl --user disable --now codebrowse
	rm -f $(BIN) $(UNIT)
	systemctl --user daemon-reload

restart: install

logs:
	journalctl --user -u codebrowse -f

password:
	@$(BIN) -print-password
