#!/bin/bash


docker compose --env-file ./test_net_env --env-file ./test/yamls/.env  -f ./test/yamls/services/vps_front.yaml  -f ./test/yamls/services/sigturn.yaml -f ./test/yamls/services/nat_backend.yaml -f ./test/yamls/services/backend.yaml -f ./test/yamls/services/nat_b1.yaml -f ./test/yamls/services/nat_b2.yaml -f ./test/yamls/services/browser.yaml -f ./test/yamls/networks.yaml -f ./test/yamls/volumes.yaml up