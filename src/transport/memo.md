# Command Dispatcher

The frontend sends commands to backend (duh).
The delivery channel should be made opaque to separate transport layers.
The following commands are sent to backend:
1. Database requests - when transferring big data need to split and reassemble it.
2. Website code request - a long data buffer. Need to split data when sending over SCTP.

The message format would be




```mermaid
sequenceDiagram
participant p as Peer
participant d as debouce
participant co as "Create Offer"

p ->> d: disconnected
activate d
d ->> co: restart ICE
deactivate d
activate co
p ->> co: recovered connection
co --x d: check iceconnectionstate<br>drop offer<br>exit debounce
deactivate co
```

```mermaid
sequenceDiagram
participant p as Peer
participant d as debouce
participant co as "SetLocalDescription"
participant r as "RollbackLocalSDP"

p ->> d: disconnected
activate d
d ->> co: restart ICE
deactivate d
activate co
p ->> co: recovered connection
co ->> r: check iceconnectionstate<br>drop offer
deactivate co
activate r
r --x d: exit debounce
deactivate r
```


```mermaid
sequenceDiagram
participant p as Peer
participant d as debouce
participant co as "SetLocalDescription"
participant r as "RollbackLocalSDP"

p ->> d: disconnected
activate d
d ->> co: restart ICE
deactivate d
activate co
p ->> co: recovered connection
co ->> r: check iceconnectionstate<br>drop offer
deactivate co
activate r
p ->>r: disconnected again
r ->> d: check iceconnectionstate<br>schedule new debounce
deactivate r
activate d

d ->> co: ICE restart
deactivate d
```
