<div align="center">
    <img src="./assets/favicon.svg" width="72" height="72" alt="ChainTrace logo">

# ChainTrace

### Ethereum activity, mapped as a constellation.

A minimal interactive visualization of public Ethereum wallet activity.  
Every transaction becomes a star. Counterparties form constellations. Value creates structure.

<br>

<a href="https://YOUR_GITHUB_LOGIN.github.io/chaintrace/">
    <img src="https://img.shields.io/badge/Open_Live_Demo-7687ff?style=for-the-badge" alt="Open ChainTrace">
</a>

<br><br>

<img src="https://img.shields.io/badge/JavaScript-ES2022-f7df1e?style=flat-square&logo=javascript&logoColor=000000" alt="JavaScript">
<img src="https://img.shields.io/badge/jQuery-3.7.1-0769ad?style=flat-square&logo=jquery&logoColor=ffffff" alt="jQuery">
<img src="https://img.shields.io/badge/Apache_ECharts-5.6-aa344d?style=flat-square&logo=apacheecharts&logoColor=ffffff" alt="Apache ECharts">
<img src="https://img.shields.io/badge/Blockscout-API-5b68df?style=flat-square" alt="Blockscout API">
<img src="https://img.shields.io/badge/GitHub-Pages-181717?style=flat-square&logo=github" alt="GitHub Pages">

</div>

---

## About

ChainTrace transforms the latest Ethereum wallet transactions into an interactive data space.

Instead of presenting blockchain activity as another table, the application builds a navigable constellation:

- the observed wallet becomes the central star;
- counterparties form surrounding clusters;
- every transaction is represented by a separate star;
- connections visualize the direction and structure of value movement;
- color, size and position encode transaction properties.

The entire project runs directly in the browser and requires no wallet connection, backend server or private API key.

## Features

- Visualization of up to 100 latest Ethereum transactions
- One visible star for every transaction
- Counterparty-based constellation clustering
- Incoming, outgoing, contract and failed transaction filters
- Interactive Canvas graph with zooming and navigation
- Detailed transaction inspector
- Wallet balance, transferred value and gas metrics
- Direction distribution and activity charts
- Animated data-space flight while blockchain data loads
- Deterministic wallet sectors and graph positioning
- Direct links to Blockscout transactions and addresses
- URL-based wallet sharing
- Responsive dark interface
- Public, read-only blockchain data

## Visualization

| Element | Meaning |
|---|---|
| Central star | Observed Ethereum wallet |
| Diamond node | Counterparty cluster |
| Small star | Individual transaction |
| Green | Incoming transaction |
| Violet | Outgoing transaction |
| Amber | Contract interaction |
| Red | Failed transaction |
| Star size | Relative transferred value |
| Connection | Wallet, counterparty and transaction relationship |

## Technology

| Layer | Technology |
|---|---|
| Interface | HTML5 and CSS3 |
| Application logic | JavaScript and jQuery |
| Visualization | Apache ECharts Canvas renderer |
| Ambient space | Custom Canvas particle engine |
| Blockchain data | Blockscout REST API |
| Hosting | GitHub Pages |
| Deployment | Static files from the `main` branch |

## Data flow

1. The user enters a public Ethereum address.
2. ChainTrace validates and normalizes the address.
3. The browser requests wallet activity from Blockscout.
4. Transactions are normalized into a common internal model.
5. Counterparties and transaction relationships are calculated.
6. ECharts renders the resulting constellation on Canvas.
7. Selecting a star opens its transaction details.

## Run locally

Docker is the easiest way to run ChainTrace with a proper HTTP origin.

```powershell
git clone https://github.com/demon-cheg/chaintrace.git
cd chaintrace

docker run --rm --name chaintrace-preview `
    -p 8085:80 `
    -v "${PWD}:/usr/share/nginx/html:ro" `
    nginx:alpine
