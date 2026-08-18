


To test WebRTC datachannel connectivity a set of services will be deployed.
The following things will need to be tested:
1) Carrier change
2) Connectivity loss
3) Ice restarts
4) Page reloads
5) Regular operation over opened data channel

All services will have to be deployed:
1) Browser
2) Turn server
3) Signalling server
4) Rust service
5) Test orchestration service
6) Browser NAT connects with (1)
7) Rust NAT connects with (4)
8) vps nat connects with (3)

* (2) and (4) will need to have at least 2 interfaces for connection with each other
* (2) and (4) will have to be behind NATs to emulate real world networks
* Extra interface will have to exist to connect everyone with the (5)

### Orchestration

#### Orchestration script
Runs first.
Builds rust artifacts.
Runs the docker compose sript and provides environment variables required to provide mounting points, source directories and the artifacts and other variables to expose to the sevice mesh.

#### Orchestration service
Sends commands to other services and observes results.
Synchronises events.
Decides if tests pass or fail.

```mermaid
flowchart TD
  subgraph Browser["Browser"]
    ifOrcBrowser["Orc IF"]
    subgraph puppeteer["Puppeteer service"]
        puppeteerBrowser["Headless Chrome"]
        puppeteerOrcServer["Orchestrator agent"]
    end
    puppeteerOrcServer ~~~ puppeteerBrowser
    ifBrowserBrowser1["Browser IF1"]
    ifBrowserBrowser2["Browser IF2"]
    puppeteerBrowser --- ifBrowserBrowser1
    puppeteerBrowser --- ifBrowserBrowser2
    ifOrcBrowser --- puppeteerOrcServer 
  end

  subgraph BrowserNAT1["Browser NAT"1]
    ifBrowserBrowserNat1["Browser IF"]
    ifEdgeBrowserNat1["Edge IF"]
  end

  subgraph BrowserNAT2["Browser NAT"2]
    ifBrowserBrowserNat2["Browser IF"]
    ifEdgeBrowserNat2["Edge IF"]
  end
  subgraph RustSvc["Backend"]
    ifOrcRust["Orc IF"]
    subgraph backendImpl["App"]
        backendOrcServer["Orchestrator agent"]
        backendServer["Service"]
    end
    backendOrcServer ~~~ backendServer
    ifOrcRust --- backendOrcServer
    ifRustRust["Rust IF"]
    backendServer --- ifRustRust
  end

  subgraph RustNAT["Rust NAT"]
    ifRustRustnat["Rust IF"]
    ifEdgeRustnat["Edge IF"]
  end

  subgraph VpsNAT["VPS NAT"]
    ifVpsVpsnat["Vps IF"]
    ifEdgeVpsnat["Edge IF"]
  end

  subgraph Sigturn["Signalling and Turn Server"]
    subgraph sigserver["Signalling service"]
        sigserverServer["Signalling WS server"]
        sigserverOrcServer["Orchestrator agent"]
    end
    sigserverOrcServer ~~~ sigserverServer
    
    coturn["Coturn"]

    ifOrcSigturn["Orc IF"]
    ifVpsSigturn["Vps IF"]
    coturn --- |listening-ip|ifVpsSigturn
    sigserverServer --- ifVpsSigturn
    ifOrcSigturn --- sigserverOrcServer
  end

  subgraph orchestrator["Orchestrator"]
    ifOrcOrchestrator["Orc IF"]
  end

  sbntBrowserGateway1["Browser Subnet 1"]
  sbntBrowserGateway2["Browser Subnet 2"]
  sbntRustGateway["Subnet Rust"]
  sbntEdgeGateway["Subnet Edge"]
  sbntVpsGateway["Subnet Vps"]
  sbntOrcGateway["Subnet Orc"]

  %% orcestration subnet
  sbntOrcGateway --- ifOrcBrowser 
  sbntOrcGateway --- ifOrcRust 
  sbntOrcGateway --- ifOrcOrchestrator 
  sbntOrcGateway --- ifOrcSigturn 

  %% Browser subnet
  ifBrowserBrowser1 --- sbntBrowserGateway1
  sbntBrowserGateway1 --- ifBrowserBrowserNat1

  ifBrowserBrowser2 --- sbntBrowserGateway2
  sbntBrowserGateway2 --- ifBrowserBrowserNat2

  %% Rust subnet
  ifRustRust --- sbntRustGateway
  sbntRustGateway --- ifRustRustnat 

  %% NAT interconnect subnet
  ifEdgeBrowserNat1 --- sbntEdgeGateway
  ifEdgeBrowserNat2 --- sbntEdgeGateway
  ifEdgeRustnat --- sbntEdgeGateway
  ifEdgeVpsnat --- |masquerade|sbntEdgeGateway

  %% VPS subnet
  coturn --- |external-ip|ifEdgeVpsnat
  ifVpsSigturn --- |"  /\ <br>DNAT"|ifEdgeVpsnat
  sbntVpsGateway --- ifVpsVpsnat
  ifVpsSigturn --- sbntVpsGateway
```

Img. 1. <a id = "img_network_layout">Network layout</a>

#### Carrier change
Emulated as swapping network interfaces: disable old interface and enable new one.
On the [network layout](#img_network_layout) the Browser service has 2 network cards and they will be swapped on command.