import React, { useContext, useEffect } from 'react';
import { PeerContext } from '@cerc-io/react-peer'

import { Peer } from '@cerc-io/peer';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { AppBar, Box, CssBaseline, Paper, Table, TableBody, TableCell, TableContainer, TableRow, Toolbar, Typography } from '@mui/material';

import './App.css';
import { useForceUpdate } from './hooks/forceUpdate';

declare global {
  interface Window { broadcast: (message: string) => void; }
}

const theme = createTheme();

function App() {
  const forceUpdate = useForceUpdate();
  const peer: Peer = useContext(PeerContext);

  useEffect(() => {
    if (!peer || !peer.node) {
      return
    }

    // Subscribe to messages from remote peers
    const unsubscribeMessage = peer.subscribeMessage((peerId, message) => {
      console.log(`${peerId.toString()} > ${message}`)
    })

    // Expose broadcast method in browser to send messages
    window.broadcast = (message: string) => {
      peer.broadcastMessage(message)
    }

    peer.node.peerStore.addEventListener('change:multiaddrs', forceUpdate)
    peer.node.connectionManager.addEventListener('peer:connect', forceUpdate)

    let lastDisconnect = new Date()
    const disconnectHandler = () => {
      forceUpdate()

      const now = new Date();
      const disconnectAfterSeconds = (now.getTime() - lastDisconnect.getTime()) / 1000;
      console.log("Disconnected after seconds:", disconnectAfterSeconds);
      lastDisconnect = now;
    }

    peer.node.connectionManager.addEventListener('peer:disconnect', disconnectHandler)

    return () => {
      unsubscribeMessage()
      peer.node?.peerStore.removeEventListener('change:multiaddrs', forceUpdate)
      peer.node?.connectionManager.removeEventListener('peer:connect', forceUpdate)
      peer.node?.connectionManager.removeEventListener('peer:disconnect', disconnectHandler)
    }
  }, [peer, forceUpdate])

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="relative">
        <Toolbar>
          <Typography variant="h6" color="inherit" noWrap>
            Peer Test App
          </Typography>
        </Toolbar>  
      </AppBar>
      <main>
        <Box
          sx={{
            bgcolor: 'background.paper',
            py: 3,
            px: 3
          }}
        >
          <Typography variant="subtitle1" color="inherit" noWrap>
            Self Node Info
          </Typography>
          <br/>
          <TableContainer component={Paper}>
            <Table>
              <TableBody>
                <TableRow>
                  <TableCell><b>Peer ID</b></TableCell>
                  <TableCell>{peer && peer.peerId && peer.peerId.toString()}</TableCell>
                  <TableCell align="right"><b>Node started</b></TableCell>
                  <TableCell>{peer && peer.node && peer.node.isStarted().toString()}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell><b>Signal server</b></TableCell>
                  <TableCell>{process.env.REACT_APP_SIGNAL_SERVER}</TableCell>
                  <TableCell align="right"><b>Relay node</b></TableCell>
                  <TableCell>{process.env.REACT_APP_RELAY_NODE}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell><b>Multiaddrs</b></TableCell>
                  <TableCell colSpan={3}>
                    <TableContainer>
                      <Table size="small">
                        <TableBody>
                          {
                            peer && peer.node && peer.node.getMultiaddrs().map(multiaddr => (
                              <TableRow key={multiaddr.toString()}>
                                <TableCell sx={{ px: 0 }}>
                                  {multiaddr.toString()}
                                </TableCell>
                              </TableRow>
                            ))
                          }
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableContainer>
          <br/>
          {
            peer && peer.node && (
              <>
                <Typography variant="subtitle1" color="inherit" noWrap>
                  Remote Peer Connections (Count: {peer.node.connectionManager.getConnections().length})
                </Typography>
                <br/>
                {peer.node.connectionManager.getConnections().map(connection => (
                  <TableContainer sx={{ mb: 2 }} key={connection.id} component={Paper}>
                    <Table size="small">
                      <TableBody>
                        <TableRow>
                          <TableCell sx={{ width: 175 }}><b>Connection ID</b></TableCell>
                          <TableCell>{connection.id}</TableCell>
                          <TableCell align="right"><b>Direction</b></TableCell>
                          <TableCell>{connection.stat.direction}</TableCell>
                          <TableCell align="right"><b>Status</b></TableCell>
                          <TableCell>{connection.stat.status}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell sx={{ width: 175 }}><b>Peer ID</b></TableCell>
                          <TableCell colSpan={5}>{connection.remotePeer.toString()}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell sx={{ width: 175 }}><b>Connected multiaddr</b></TableCell>
                          <TableCell colSpan={5}>
                            {connection.remoteAddr.toString()}
                            &nbsp;
                            <b>{connection.remoteAddr.toString() === process.env.REACT_APP_RELAY_NODE && "(RELAY NODE)"}</b>
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </TableContainer>
                ))}
              </>
            )
          }
        </Box>
      </main>
    </ThemeProvider>
  );
}

export default App;