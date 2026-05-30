# Small helper to inline allocator/main.py into the ConfigMap before apply.
# Avoids hand-syncing two copies of the script.

KUBECTL ?= kubectl
NS      ?= browser-pool
ML110   ?= root@100.108.4.108

.PHONY: help bundle apply restart status logs smoke clean

help:
	@echo "Targets:"
	@echo "  make bundle           # render k8s/20-allocator.yaml with main.py inlined"
	@echo "  make apply            # kubectl apply -f the rendered manifests"
	@echo "  make restart          # restart allocator + chrome-vnc (pick up new code/image)"
	@echo "  make status           # kubectl get all -n $(NS)"
	@echo "  make logs             # tail allocator logs"
	@echo "  make smoke            # run tests/smoke.py against the live allocator"
	@echo "  make clean            # delete the namespace"

# Render the allocator ConfigMap with main.py inlined into a tmp directory.
build/k8s/20-allocator.rendered.yaml: allocator/main.py k8s/20-allocator.yaml
	@mkdir -p build/k8s
	@awk -v code_file="allocator/main.py" '\
		/{{ ALLOCATOR_MAIN_PY }}/ { \
			while ((getline line < code_file) > 0) print "    " line; \
			next; \
		} \
		{ print }' k8s/20-allocator.yaml > $@
	@echo "rendered -> $@"

# Render the chrome-vnc ConfigMap with control-sidecar.mjs inlined.
build/k8s/40-chrome-vnc-poc.rendered.yaml: scripts/control-sidecar.mjs k8s/40-chrome-vnc-poc.yaml
	@mkdir -p build/k8s
	@awk -v code_file="scripts/control-sidecar.mjs" '\
		/{{ CONTROL_SIDECAR_MJS }}/ { \
			while ((getline line < code_file) > 0) print "    " line; \
			next; \
		} \
		{ print }' k8s/40-chrome-vnc-poc.yaml > $@
	@echo "rendered -> $@"

bundle: build/k8s/20-allocator.rendered.yaml build/k8s/40-chrome-vnc-poc.rendered.yaml
	@cp k8s/00-namespace.yaml build/k8s/00-namespace.yaml
	@cp k8s/30-cloudflared-tunnel.yaml build/k8s/30-cloudflared-tunnel.yaml

apply: bundle
	$(KUBECTL) apply -f build/k8s/00-namespace.yaml
	$(KUBECTL) apply -f build/k8s/40-chrome-vnc-poc.rendered.yaml
	$(KUBECTL) apply -f build/k8s/20-allocator.rendered.yaml
	$(KUBECTL) apply -f build/k8s/30-cloudflared-tunnel.yaml

restart:
	$(KUBECTL) -n $(NS) rollout restart deploy/allocator
	$(KUBECTL) -n $(NS) rollout restart statefulset/chrome-vnc

status:
	$(KUBECTL) get all -n $(NS)

logs:
	$(KUBECTL) -n $(NS) logs -f deploy/allocator --tail=200

smoke:
	python tests/smoke.py

clean:
	$(KUBECTL) delete namespace $(NS) --wait=false

# Remote variants: scp this directory to ML110 and run `make apply` there.
remote-apply:
	ssh $(ML110) 'mkdir -p /root/browser-pool'
	rsync -a --delete --exclude build --exclude __pycache__ ./ $(ML110):/root/browser-pool/
	ssh $(ML110) 'cd /root/browser-pool && KUBECONFIG=/etc/rancher/k3s/k3s.yaml make apply'
