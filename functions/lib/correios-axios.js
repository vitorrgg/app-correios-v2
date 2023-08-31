const { getFirestore, Timestamp } = require('firebase-admin/firestore')
const axios = require('axios')

const baseURL = 'https://api.correios.com.br/'

const newCorreiosAuth = async (storeId, { username, accessCode } = {}) => {
  if (!username || !accessCode) {
    const docSnapshot = await getFirestore().doc(`correios_contracts/${storeId}`).get()
    if (!docSnapshot.exists) {
      throw new Error('No Correios contract credentials')
    }
    username = docSnapshot.get('username')
    accessCode = docSnapshot.get('accessCode')
  }
  return axios.create({
    baseURL,
    timeout: 6000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' +
        Buffer.from(`${username}:${accessCode}`, 'utf8').toString('base64')
    }
  })
}

const newCorreios = async (storeId, { username, accessCode, postCardNumber } = {}) => {
  let token
  let correiosContract
  const docRef = getFirestore().doc(`correios_contracts/${storeId}`)
  let correiosAuth
  if (username && accessCode && postCardNumber) {
    correiosAuth = await newCorreiosAuth(storeId, { username, accessCode })
  } else {
    const docSnapshot = await docRef.get()
    if (docSnapshot.exists) {
      const { expiredAt, ...docData } = docSnapshot.data()
      const now = Timestamp.now().toMillis()
      if (now + 9000 < expiredAt.toMillis()) {
        token = docData.token
      } else {
        correiosAuth = await newCorreiosAuth(storeId, docData)
      }
      postCardNumber = docData.postCardNumber
      correiosContract = docData
    } else {
      throw Error('No Correios contract document')
    }
  }
  if (correiosAuth) {
    const { data } = await correiosAuth.post('/token/v1/autentica/cartaopostagem', {
      numero: postCardNumber
    })
    token = data.token
    const { cartaoPostagem, cnpj } = data
    const nuContrato = cartaoPostagem.contrato
    const nuDR = cartaoPostagem.dr
    if (!correiosContract) {
      correiosContract = {
        storeId,
        username,
        accessCode,
        postCardNumber,
        nuContrato,
        nuDR,
        cnpj,
        token,
        cartaoPostagem
      }
    } else {
      Object.assign(correiosContract, {
        nuContrato,
        nuDR,
        cnpj,
        token,
        cartaoPostagem
      })
    }
    docRef.set({
      ...correiosContract,
      expiredAt: Timestamp.fromDate(new Date(data.expiraEm))
    }, { merge: true })
  }
  const correios = axios.create({
    baseURL,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  })
  correios.$contract = correiosContract
  return correios
}

module.exports = { newCorreiosAuth, newCorreios }
