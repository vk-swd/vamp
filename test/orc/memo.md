### Orchestration agent

Makes requests to tested services.
It will send commands and collect ersponses/metrics to observe behavior.
Commands and state will be polled through http requests/polling.
Commands:
1) Restart ICE - Browser and Backend - rebly will send back the answer or an error report
2) Get events - check the timings and delays of incoming messages and rtc events. (will need instrumentation for tests)
3) Close connection
4) Open connection: provide parameters, including signalling server address, ice servers.
5) Switch network interfaces - change the network interfaces - that would only work for the browser, to emulate change of network providers.
6) (Dis)connect to signalling server - for backend to open a room and start waiting for offers
