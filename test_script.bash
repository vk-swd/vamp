#!/bin/bash



compose_files=(
  # -f ./test/yamls/services/vps_front.yaml
  # -f ./test/yamls/services/sigturn.yaml

  # -f ./test/yamls/services/nat_backend.yaml
  # -f ./test/yamls/services/backend.yaml
  
  # -f ./test/yamls/services/nat_b1.yaml
  # -f ./test/yamls/services/nat_b2.yaml
  # -f ./test/yamls/services/browser.yaml

  -f ./test/yamls/services/sigturn_local.yaml
  -f ./test/yamls/networks.yaml
  -f ./test/yamls/volumes.yaml

  # -f ./test/yamls/misc/test_builder.yaml
  # -f ./test/yamls/module_orchestrator.yaml
)

# docker compose \
#   --env-file ./test_net_env \
#   --env-file ./test/yamls/.env \
#   -f ./test/yamls/images/browserpup.yaml \
#   -f ./test/yamls/images/router.yaml \
#   -f ./test/yamls/images/sigturn_img.yaml \
#   build router browserpup sigturn_img

# docker compose \
#   --env-file ./test_net_env \
#   --env-file ./test/yamls/.env \
#   -f ./test/yamls/misc/test_builder.yaml \
#   up



docker compose \
  --env-file ./test_net_env \
  "${compose_files[@]}" \
  stop -t 0 
  # down -t 0 --remove-orphans
docker compose \
  --env-file ./test_net_env \
  "${compose_files[@]}" \
  up -d
  
