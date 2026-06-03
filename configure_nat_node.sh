LOCAL_NIC=$1
EDGE_NIC=$2

if [ -z "$LOCAL_NIC" ] || [ -z "$EDGE_NIC" ]; then
  echo "Error: usage: configure_nat_node.sh <local_nic> <edge_nic>" >&2
  exit 1
fi

echo 1 > /proc/sys/net/ipv4/ip_forward
iptables -t nat -A POSTROUTING -o $EDGE_NIC -j MASQUERADE
iptables -A FORWARD -i $LOCAL_NIC -o $EDGE_NIC -j ACCEPT
iptables -A FORWARD -i $EDGE_NIC -o $LOCAL_NIC -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A FORWARD -i $EDGE_NIC -o $LOCAL_NIC -j DROP
tail -f /dev/null
