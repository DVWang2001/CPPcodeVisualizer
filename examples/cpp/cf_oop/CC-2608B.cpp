#include<iostream>
#include<vector>
#include<algorithm>
#include<cstdlib>
using namespace std;
typedef long long LL;
class Frac{public:
  LL m_n,m_d;
  Frac(LL n=0,LL d=1):m_n(n),m_d(d){}
  void operator+=(Frac b){m_n=m_n*b.m_d+m_d*b.m_n;m_d*=b.m_d;}
  void operator*=(Frac b){m_n=m_n*b.m_n;m_d*=b.m_d;}
  Frac operator/(int b){return  Frac(m_n,m_d*b);}
};
istream& operator>>(istream &is,Frac &a){
  char c;
  return is>>a.m_n>>c>>a.m_d;
}
ostream& operator<<(ostream &os,const Frac &a){return os<<a.m_n<<"/"<<a.m_d;}
class FVec{public:
  vector<Frac> m_vs;
  Frac reduce(Frac f){
    LL g=std::__gcd(f.m_n<0?-f.m_n:f.m_n, f.m_d<0?-f.m_d:f.m_d);
    if(g!=0){ f.m_n/=g; f.m_d/=g; }
    return f;
  }
  Frac sum(){
    Frac s;
    for(auto &v: m_vs) s+=v;
    return reduce(s);
  }
  Frac pro(){
    Frac p(1,1);
    for(auto &v: m_vs) p*=v;
    return reduce(p);
  }
  Frac avg(){
    return reduce(sum()/(int)m_vs.size());
  }
};
istream& operator>>(istream &is,FVec &vs){
  int n;is>>n;Frac v;
  while(n--){is>>v;vs.m_vs.push_back(v);}
  return is;
}
int main(){
  FVec a;cin>>a;
  cout<<a.sum()<<endl<<a.pro()<<endl<<a.avg()<<endl;  //@ @guide uml:a
  return 0;
}
