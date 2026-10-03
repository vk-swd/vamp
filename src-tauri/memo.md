

This is a backend service managing database and handling requests from Tauri/webview or browser client.

Since the backend manages requests from authorised users, rate limiting or request serialisation is not enforced. Only metrics like max request duration and max in flight reqeusts are introduced for monitoring.


#### Authorisation
No user separation is implemented. One service runs one database used by one person.

One database can have access from:
1. Tauri Webview
2. Browser through a websocket server exposed to the internet
3. Browser through a p2p connection.

Simultaneous use is possible and it may cause problems such as:
1. Double accounting for listened tracks (if several devices are listening for the same thing) - questionable as a problem though
2. Make conflict database writes: adding/removing/modifying same tracks - just make database verify ooperations. DB access is serialised by SQlite and make RMW updates.
3. Contention - not at this scale.


