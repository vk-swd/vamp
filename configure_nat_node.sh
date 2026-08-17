NIF=$1
EDGE_NIF=$2

if [ -z "$NIF" ] || [ -z "$EDGE_NIF" ]; then
  echo "Error: usage: configure_nat_node.sh <local_nic> <edge_nic>" >&2
  exit 1
fi

echo 1 > /proc/sys/net/ipv4/ip_forward
iptables -t nat -A POSTROUTING -o $EDGE_NIF -j MASQUERADE
iptables -A FORWARD -i $NIF -o $EDGE_NIF -j ACCEPT
iptables -A FORWARD -i $EDGE_NIF -o $NIF -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A FORWARD -i $EDGE_NIF -o $NIF -j DROP
tail -f /dev/null
